/**
 * Rendering of the evidence blocks injected into the conversation.
 *
 * Everything here is pure: the caller decides *whether* to inject, this module
 * decides what the model reads and how much of the budget it costs.
 *
 * Retrieved text is untrusted. A document whose body contains `</kb-evidence>`
 * (or a title shaped like a citation list) must not be able to close the block
 * or forge markers, so `<` is escaped the same way the harness escapes session
 * references: as the `\u003c` sequence, which no parser reads as a tag.
 */

const RULE_TAIL = [
  '1. 只能依据 <kb-evidence> 中的片段回答组织内部事实；不得用你自己的常识、行业惯例或记忆补充。',
  '2. 每个结论句后标注片段编号（如 [K2]）；回答末尾列出引用清单：文档名 + knowledge_id + chunk 序号。',
  '3. 证据不足以回答时，明确写「知识库中没有足够证据」，并说明缺什么，不要给出推测性结论。',
  '4. 片段与问题冲突时，以片段为准，并指出冲突。',
];

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Neutralise framing tags inside untrusted text. */
function escapeUntrusted(value) {
  return String(value ?? '').replace(/</g, '\\u003c');
}

function kbScopeLabel(kbNames, kbIds) {
  if (Array.isArray(kbNames) && kbNames.length > 0) return kbNames.join('、');
  if (Array.isArray(kbIds) && kbIds.length > 0) return kbIds.join(', ');
  return '该凭据可见的全部知识库';
}

function ruleLines(toolPrefix) {
  const prefix = typeof toolPrefix === 'string' && toolPrefix !== '' ? toolPrefix : 'wkg';
  return [
    ...RULE_TAIL,
    `5. 交付前可调用 ${prefix}_check_citations 工具自检引用是否都能对上本轮片段。`,
  ];
}

function footer(toolPrefix) {
  return ['</kb-evidence>', '', '<kb-rule>', ...ruleLines(toolPrefix), '</kb-rule>'];
}

/**
 * Render the evidence block plus its rule block.
 *
 * The character budget covers the whole block, footer included; hits are cut
 * when the budget runs out and the report says how many were omitted, so the
 * model knows the evidence page was truncated rather than complete.
 *
 * @param {object} input
 * @param {object[]} input.hits annotated hits, each carrying `marker` (K1, K2, …)
 * @param {string} input.query
 * @param {number} [input.turn]
 * @param {string} [input.source] 'pre-step' | 'search' | 'ask'
 * @param {number} [input.budget]
 * @param {string[]} [input.kbNames]
 * @param {string[]} [input.kbIds]
 * @param {string} [input.toolPrefix]
 * @param {{kbId?: string, error: string}[]} [input.failures] knowledge bases whose retrieval failed
 * @returns {{block: string, included: number, omitted: number, chars: number}}
 */
export function renderEvidence(input) {
  const hits = Array.isArray(input.hits) ? input.hits : [];
  const budget = typeof input.budget === 'number' ? input.budget : 4_000;
  const failures = Array.isArray(input.failures) ? input.failures : [];
  const tail = footer(input.toolPrefix);
  const head = [
    `<kb-evidence turn="${input.turn ?? ''}" source="${escapeAttr(input.source ?? 'pre-step')}" query="${escapeAttr(input.query)}">`,
    `以下片段由 WeKnora 知识库（${kbScopeLabel(input.kbNames, input.kbIds)}）检索得到，编号 [K1]… 是本轮唯一允许的组织事实来源。`,
  ];
  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `${failure.kbId ?? '全部知识库'}: ${escapeUntrusted(String(failure.error ?? 'unknown').slice(0, 120))}`)
      .join('；');
    head.push(`（注意：以下知识库本轮检索失败，证据不完整 —— ${detail}）`);
  }
  const headChars = head.join('\n').length;
  const tailChars = tail.join('\n').length;
  // Leave room for the framing, the rules and the "omitted" note so `chars`
  // never exceeds the budget.
  const noteAllowance = 96;
  const room = Math.max(0, budget - headChars - tailChars - noteAllowance);
  const body = [];
  let bodyChars = 0;
  let included = 0;
  let omitted = 0;
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    const marker = hit.marker ?? `K${i + 1}`;
    const header = `[${marker}] 《${escapeUntrusted(hit.document) || '(未命名文档)'}》 · knowledge_id: ${escapeUntrusted(hit.knowledge_id)}`
      + ` · chunk: ${hit.chunk_index} · score: ${(hit.score ?? 0).toFixed(3)} · coverage: ${(hit.coverage ?? 0).toFixed(2)}`;
    let text = `内容：${escapeUntrusted(String(hit.content ?? '').replace(/\s+/g, ' ').trim())}`;
    const available = room - bodyChars;
    if (available <= header.length + 32) {
      omitted = hits.length - i;
      break;
    }
    if (header.length + text.length + 2 > available) {
      text = `${text.slice(0, Math.max(0, available - header.length - 12))}…`;
      body.push(header, text);
      bodyChars += header.length + text.length + 2;
      included += 1;
      omitted = hits.length - i - 1;
      break;
    }
    body.push(header, text);
    bodyChars += header.length + text.length + 2;
    included += 1;
  }
  if (omitted > 0) {
    const note = `（预算所限，另有 ${omitted} 条片段未展示；如需更多上下文请调用 read 工具读取整篇文档。）`;
    body.push(note);
    bodyChars += note.length + 1;
  }
  const block = [...head, ...body, ...tail].join('\n');
  return { block, included, omitted, chars: block.length };
}

/**
 * Render the "retrieval ran, nothing passed the gate" block. The model is told
 * the search happened and found nothing usable — not that the KB is empty.
 * @param {{query: string, turn?: number, diagnostics?: object, kbNames?: string[], kbIds?: string[], toolPrefix?: string}} input
 * @returns {{block: string, included: number, omitted: number, chars: number}}
 */
export function renderInsufficient(input) {
  const d = input.diagnostics ?? {};
  const detail = [
    `候选片段 ${d.candidate_count ?? 0} 条`,
    `最高覆盖率 ${(d.top_coverage ?? 0).toFixed(2)} < 阈值 ${(d.min_coverage ?? 0).toFixed(2)}`,
    d.dropped_missing_provenance ? `${d.dropped_missing_provenance} 条缺少可引用标识` : null,
  ].filter(Boolean).join('；');
  const block = [
    `<kb-evidence turn="${input.turn ?? ''}" source="${escapeAttr(input.source ?? 'pre-step')}" query="${escapeAttr(input.query)}" insufficient="true">`,
    `已检索 WeKnora 知识库（${kbScopeLabel(input.kbNames, input.kbIds)}），但没有片段达到证据门槛：${detail}。`,
    '</kb-evidence>',
    '',
    '<kb-rule>',
    '1. 本轮不得凭记忆或常识回答该问题，必须明确说明「知识库中没有足够证据」。',
    '2. 说明缺什么信息；如用户能补充关键词、文档名或知识库范围，请一并询问。',
    '3. 不要先给出通用答案再说"这不是知识库内容"——顺序不能颠倒。',
    '</kb-rule>',
  ].join('\n');
  return { block, included: 0, omitted: d.candidate_count ?? 0, chars: block.length };
}

/**
 * Render the "retrieval itself failed" block. This is a fail-closed answer for
 * grounding purposes without lying about the knowledge base: the model must say
 * retrieval is unavailable, not that there is no evidence.
 * @param {{query: string, turn?: number, failures: {kbId?: string, error: string}[], kbNames?: string[], kbIds?: string[]}} input
 */
export function renderUnavailable(input) {
  const failures = Array.isArray(input.failures) ? input.failures : [];
  const detail = failures.length === 0
    ? '未知错误'
    : failures.map((f) => `${f.kbId ?? '全部知识库'}: ${escapeUntrusted(String(f.error ?? 'unknown').slice(0, 160))}`).join('；');
  const block = [
    `<kb-evidence turn="${input.turn ?? ''}" source="${escapeAttr(input.source ?? 'pre-step')}" query="${escapeAttr(input.query)}" unavailable="true">`,
    `WeKnora 检索失败，本轮没有拿到任何证据（${detail}）。`,
    '</kb-evidence>',
    '',
    '<kb-rule>',
    '1. 不得凭记忆回答组织内部事实。',
    '2. 明确告知用户"知识库检索当前不可用"，并复述失败原因；建议其检查 WeKnora 服务或凭据后重试。',
    '3. 不要把"检索失败"说成"知识库没有证据"——两者含义不同。',
    '</kb-rule>',
  ].join('\n');
  return { block, included: 0, omitted: 0, chars: block.length };
}

/** The rule lines alone, used by callers that want the same wording. */
export function ruleLinesFor(toolPrefix) {
  return ruleLines(toolPrefix);
}
