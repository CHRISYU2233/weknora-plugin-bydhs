import { WeknoraClient } from './client.js'
import { resolveConfig, ConfigError } from './config.js'
import { createTools } from './tools.js'
import { annotateHits, shouldGround } from './gate.js'
import { renderEvidence, renderInsufficient, renderUnavailable } from './evidence.js'
import { createEvidenceLedger, createTurnTracker, createGroundedSet } from './state.js'

export const name = 'WeKnora_plugin_byDHS'
export const inject = ['tools', 'systemPrompt', 'credentials']
export { ConfigError, resolveConfig, normalizeBaseUrl } from './config.js'
export { WeknoraClient, WeknoraApiError } from './client.js'
export { createTools } from './tools.js'
export { annotateHits, shouldGround, queryTerms, coverageOf } from './gate.js'
export { parseMarkers, parseInlineCitations, verifyCitations, renderCitationReport } from './cite.js'

const SECTION_NAME = 'weknora-bydhs:policy'

export async function apply(ctx, config) {
  const resolved = resolveConfig(config)
  // The API key comes from the row's `apiKey`, and otherwise from the
  // deployment's own credential store (the same facility the model keys use),
  // so a profile never has to carry plaintext in its patch file.
  if (!resolved.apiKey) {
    resolved.apiKey = await resolveCredential(ctx, resolved.apiKeyRef)
    if (!resolved.apiKey) {
      throw new ConfigError([
        `no WeKnora API key: set config.apiKey, or store "${resolved.apiKeyRef}" in the credential store`,
      ])
    }
  }
  const client = new WeknoraClient(resolved)
  const ledger = createEvidenceLedger({ maxContentChars: resolved.maxChunkChars })
  const turns = createTurnTracker()
  const grounded = createGroundedSet()

  const registered = []
  for (const def of createTools(client, resolved, { ledger })) {
    ctx.tools.register(def)
    registered.push(def.name)
  }

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolved.policyOrder,
    text: policyText(resolved),
  })

  // Host seams are optional: a bare stub context (unit tests, the verify
  // script) has no event bus, and the tools must still register.
  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', (payload, next) => onPreStep(payload, next, { ctx, client, resolved, ledger, turns, grounded }))
    ctx.on('agent/request', (payload, next) => onRequest(payload, next, { ctx, resolved, grounded }))
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      ledger.clear()
      turns.clear()
      grounded.clear()
    })
  }

  ctx.logger?.info?.(
    `WeKnora_plugin_byDHS: registered ${registered.join(', ')} + grounding policy against ${resolved.baseUrl} `
    + `(enforce=${resolved.enforce}, injectEvidence=${resolved.injectEvidence}, order=${resolved.policyOrder})`,
  )
}

/** Read one reference from the DSH credential store; undefined when unset. */
async function resolveCredential(ctx, ref) {
  try {
    const entry = await ctx.credentials?.resolve?.(ref)
    const value = typeof entry === 'string' ? entry : entry?.value
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch (error) {
    ctx.logger?.warn?.(`WeKnora_plugin_byDHS: credential "${ref}" unavailable: ${error?.message ?? error}`)
    return undefined
  }
}

/* ------------------------------------------------------------------ hooks */

/**
 * Grounding at `agent/pre-step`.
 *
 * The point of this hook is that "search before answering" stops being a model
 * decision: the retrieval runs before the step enters, and the passages are
 * appended to the entering user message. The tools stay available for follow-up
 * (multi-hop) retrieval, but the first evidence page cannot be skipped.
 *
 * The batch the loop hands to `next()` ends with its own runtime-context
 * snapshot — a user-role message the loop re-projects and commits in place of
 * whatever the decision carried. Appending evidence there would be silently
 * dropped at commit time, so the target is the *claimed* user message from
 * `payload.messages`, which is committed verbatim.
 */
async function onPreStep(payload, next, deps) {
  const base = await next()
  const { ctx, client, resolved, ledger, turns, grounded } = deps
  if (!resolved.injectEvidence) return base
  if (base === null || typeof base !== 'object' || base.kind !== 'enter') return base
  try {
    const claimed = Array.isArray(payload?.messages) && payload.messages.length > 0
      ? payload.messages
      : (Array.isArray(base.messages) ? base.messages : [])
    const direct = lastDirectUserMessage(claimed)
    if (direct === undefined) return base
    const query = messageText(direct)
    if (!shouldGround(query, resolved)) return base

    const identity = identityOf(payload)
    // Dedupe on the user message id: later steps of the same turn claim no new
    // user message, while a mid-turn `steer`/`followup` arrives with a new id
    // and must be grounded too. A reloaded session also gets fresh ids.
    const token = typeof direct.id === 'string' && direct.id !== '' ? direct.id : undefined
    if (token !== undefined && turns.seen(identity, token)) return base
    const target = findMessage(base.messages, direct.id) ?? lastDirectUserMessage(base.messages)
    if (target === undefined) return base
    if (token !== undefined) turns.mark(identity, token)

    const turn = typeof payload?.turn === 'number' ? payload.turn : null
    const retrieval = await retrieveEvidence(client, resolved, query, payload?.signal)
    if (retrieval.hits.length > 0) {
      ledger.record({
        agentId: identity.key,
        source: 'pre-step',
        turn,
        query,
        hits: retrieval.hits,
        diagnostics: retrieval.diagnostics,
      })
    }
    // Grounded even when the gate rejects everything: the session is being
    // grounded, so the sampling cap and the "insufficient evidence" rule apply.
    grounded.add(identity)

    let rendered
    if (retrieval.hits.length === 0 && retrieval.failures.length > 0) {
      rendered = renderUnavailable({ query, turn, failures: retrieval.failures, kbIds: resolved.knowledgeBaseIds })
    } else if (retrieval.insufficient) {
      rendered = renderInsufficient({
        query, turn, source: 'pre-step', diagnostics: retrieval.diagnostics, kbIds: resolved.knowledgeBaseIds,
      })
    } else {
      rendered = renderEvidence({
        hits: retrieval.hits,
        query,
        turn,
        source: 'pre-step',
        budget: resolved.maxInjectedChars,
        kbIds: resolved.knowledgeBaseIds,
        toolPrefix: resolved.toolPrefix,
        failures: retrieval.failures,
      })
    }
    ctx.logger?.info?.(
      `WeKnora_plugin_byDHS: pre-step turn=${turn} candidates=${retrieval.diagnostics.candidate_count} `
      + `kept=${retrieval.hits.length} insufficient=${retrieval.insufficient} `
      + `failures=${retrieval.failures.length} injected=${rendered.chars}c`,
    )
    return { ...base, messages: appendBlock(base.messages, target.id, rendered.block) }
  } catch (error) {
    // Fail open: a grounding bug must not wedge the conversation. The tool
    // layer still exposes the same retrieval to the model.
    ctx.logger?.warn?.(`WeKnora_plugin_byDHS: pre-step grounding failed: ${error?.message ?? error}`)
    return base
  }
}

/** Cap sampling temperature on sessions that were grounded. */
async function onRequest(payload, next, deps) {
  const controls = await next()
  const { ctx, resolved, grounded } = deps
  try {
    if (resolved.temperatureCap === null) return controls
    if (controls === null || typeof controls !== 'object') return controls
    if (!grounded.has(identityOf(payload))) return controls
    const current = typeof controls.temperature === 'number' ? controls.temperature : undefined
    const temperature = Math.min(current ?? resolved.temperatureCap, resolved.temperatureCap)
    if (current === temperature) return controls
    return { ...controls, temperature }
  } catch (error) {
    ctx.logger?.warn?.(`WeKnora_plugin_byDHS: temperature cap skipped: ${error?.message ?? error}`)
    return controls
  }
}

/* ------------------------------------------------------------- retrieval */

/**
 * One retrieval for the pre-step injection. With several knowledge bases and
 * `perKbIsolation`, each base is queried separately so one broken deployment
 * cannot empty the whole evidence page. `signal` is the step's own signal, so a
 * cancelled step cancels the search; the client adds the request timeout.
 */
async function retrieveEvidence(client, resolved, query, signal) {
  const kbIds = resolved.knowledgeBaseIds
  const failures = []
  const rawHits = []
  let rerank = null
  if (resolved.perKbIsolation && kbIds.length > 1) {
    const settled = await Promise.allSettled(
      kbIds.map((kbId) => client.search({ query, knowledgeBaseIds: [kbId], matchCount: resolved.injectTopK }, signal)),
    )
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        rawHits.push(...outcome.value.results)
        if (rerank === null) rerank = outcome.value.rerank
      } else {
        failures.push({ kbId: kbIds[index], error: errorText(outcome.reason) })
      }
    })
  } else {
    try {
      const page = await client.search({ query, knowledgeBaseIds: kbIds, matchCount: resolved.injectTopK }, signal)
      rawHits.push(...page.results)
      rerank = page.rerank
    } catch (error) {
      failures.push({ kbId: kbIds.length === 1 ? kbIds[0] : undefined, error: errorText(error) })
    }
  }
  const { hits, insufficient, diagnostics } = annotateHits(rawHits, {
    query,
    minCoverage: resolved.minCoverage,
    minScore: resolved.minScore,
    maxResults: resolved.injectTopK,
  })
  const marked = hits.map((hit, index) => ({ ...hit, marker: `K${index + 1}` }))
  return { hits: marked, insufficient, diagnostics: { ...diagnostics, rerank }, failures, rerank }
}

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

/* --------------------------------------------------------------- messages */

/** A user-role message that is not the loop's runtime-context snapshot. */
function isDirectUserMessage(message) {
  if (message === null || typeof message !== 'object') return false
  if (message.role !== 'user') return false
  return message.source?.kind !== 'runtime-context'
}

/** Text of a message's text blocks. */
function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Last direct user message with text, or undefined. */
function lastDirectUserMessage(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!isDirectUserMessage(list[i])) continue
    if (messageText(list[i]) !== '') return list[i]
  }
  return undefined
}

/** Find a message by id. */
function findMessage(messages, id) {
  if (typeof id !== 'string' || id === '') return undefined
  return (Array.isArray(messages) ? messages : []).find((message) => message?.id === id)
}

/**
 * Append the evidence block to one message's content array.
 *
 * Only the content array is extended — no new message is created — so the
 * message keeps its id and source and the host's admission checks still hold.
 * A message whose content is not a block array is left alone rather than being
 * rewritten (that would drop the user's own text).
 */
function appendBlock(messages, targetId, block) {
  if (typeof block !== 'string' || block === '') return messages
  const out = messages.slice()
  for (let i = 0; i < out.length; i += 1) {
    const message = out[i]
    if (message === null || typeof message !== 'object') continue
    if (typeof targetId === 'string' && targetId !== '' && message.id !== targetId) continue
    if (!Array.isArray(message.content)) return messages
    out[i] = { ...message, content: [...message.content, { type: 'text', text: `\n\n${block}` }] }
    return out
  }
  return messages
}

/** Identity keys for the trackers: the agent object, plus a string id if any. */
function identityOf(payload) {
  const agent = payload?.agent
  if (agent !== null && typeof agent === 'object') {
    const id = typeof agent.id === 'string'
      ? agent.id
      : (typeof agent.session?.id === 'string' ? agent.session.id : undefined)
    return { agent, key: id }
  }
  const raw = payload?.sessionId ?? payload?.session?.id ?? payload?.session
  return { agent: undefined, key: typeof raw === 'string' ? raw : undefined }
}

/* ---------------------------------------------------------------- policy */

function policyText(c) {
  const scope = c.knowledgeBaseIds.length > 0 ? c.knowledgeBaseIds.join(', ') : '该凭据可见的全部知识库'
  const must = c.enforce ? '必须' : '应当'
  const prefix = c.toolPrefix
  const headline = c.enforce ? '# WeKnora 知识接地策略（本会话强制启用）' : '# WeKnora 知识接地策略（本会话启用）'
  return [
    headline,
    `本会话已加载 WeKnora 接地插件，目标知识库：${scope}。`,
    '检索有两条路径：宿主会在每轮用户消息进入模型前自动检索并注入 <kb-evidence> 块（无需你调用）；你也可主动调用工具补充证据。',
    `1. <kb-evidence> 中的片段是本轮唯一允许的组织事实来源。每个结论句后标注片段编号（如 [K2]），并在回答末尾列出引用清单：文档名 + knowledge_id + chunk 序号。`,
    `2. 若本轮没有 <kb-evidence>，而问题属于组织内部知识、文档、规程、设备、项目、人员约定等事实性问题，你${must}先调用 ${prefix}_search 检索；片段不足时用 ${prefix}_read 读全文，或 ${prefix}_ask 取带引用的综合回答。`,
    `3. 若问题是在问"某个主题 / 实体 / 概念在知识库里怎么讲"，可以先用 ${prefix}_wiki_search 定位 Wiki 页面，再用 ${prefix}_wiki_read 读整页；引用 Wiki 页面时写 slug + 标题。`,
    `4. 不确定有哪些知识库、或需要库 id 时，用 ${prefix}_list_knowledge_bases 查看。`,
    '5. 若 <kb-evidence insufficient="true">：检索已执行但没有片段达到证据门槛，必须明确回答「知识库中没有足够证据」，说明缺什么；不得用模型记忆或常识补全组织事实。',
    '6. 若 <kb-evidence unavailable="true">：检索本身失败，必须说明知识库检索当前不可用并复述原因，不要把它说成"没有证据"。',
    `7. 交付前可用 ${prefix}_check_citations 自检答案里的引用能否对上本轮片段；自检不通过就修正引用或降级结论。`,
    '8. 引用片段与问题冲突时，以片段为准并指出冲突。',
    '9. 仅当问题与组织知识无关（纯通用知识、闲聊、代码语法等）时，才可免检索直接回答。',
  ].join('\n')
}
