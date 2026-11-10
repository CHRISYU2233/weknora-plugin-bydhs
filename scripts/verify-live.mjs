/**
 * Live integration check against a real WeKnora deployment.
 *
 * Drives the host seams the plugin registers — `agent/pre-step` and
 * `agent/request` — plus the tools, so the evidence injection, the quality
 * gate, the turn dedupe, the temperature cap and the citation checker all run
 * against real retrieval results.
 *
 *   node scripts/verify-live.mjs [--query "你的组织知识问题"]
 *
 * Environment:
 *   WEKNORA_BASE_URL              default http://localhost:8080/api/v1
 *   WEKNORA_KNOWLEDGE_BASE_IDS    comma separated; default: every KB the key can see
 *   WEKNORA_API_KEY               if unset, read from ~/.dsh/.credentials.yaml
 *
 * The API key is never printed.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const baseUrl = process.env.WEKNORA_BASE_URL ?? 'http://localhost:8080/api/v1'
const kbIds = (process.env.WEKNORA_KNOWLEDGE_BASE_IDS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)
const queryArgIndex = process.argv.indexOf('--query')
const question = queryArgIndex >= 0 && process.argv[queryArgIndex + 1]
  ? process.argv[queryArgIndex + 1]
  : 'What is the inspection cycle for device A-17?'

function readKey() {
  if (process.env.WEKNORA_API_KEY) return process.env.WEKNORA_API_KEY
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(process.env.DSH_HOME ?? '', '.credentials.yaml'),
  ].filter((file) => file !== '' && fs.existsSync(file))
  for (const file of candidates) {
    const text = fs.readFileSync(file, 'utf8')
    const match = text.match(/^\s*WEKNORA_API_KEY\s*:\s*(.+?)\s*$/m)
    if (match) return match[1].replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

const apiKey = readKey()
if (!apiKey) {
  console.error('缺少 WEKNORA_API_KEY：请设置环境变量，或在 ~/.dsh/.credentials.yaml 的 refs 下存放该键。')
  process.exit(2)
}

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function makeContext() {
  const tools = new Map()
  const sections = new Map()
  const listeners = new Map()
  const logs = []
  const ctx = {
    tools: { register(def) { tools.set(def.name, def) } },
    systemPrompt: { section(section) { sections.set(section.name, section); return () => {} } },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {}
    },
    effect(fn) { const dispose = fn(); return () => dispose?.() },
    logger: {
      info: (m) => logs.push(String(m)),
      warn: (m) => logs.push(`WARN ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    },
  }
  return { ctx, tools, sections, listeners, logs }
}

const enter = (text, turn) => ({
  kind: 'enter',
  startsRequestSeries: true,
  messages: [{ id: `m-${turn}`, role: 'user', content: [{ type: 'text', text }] }],
})
const messageText = (decision) => (decision.messages ?? [])
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((b) => b?.type === 'text')
  .map((b) => b.text)
  .join('\n')

const { ctx, tools, sections, listeners, logs } = makeContext()
await apply(ctx, {
  baseUrl,
  apiKey,
  knowledgeBaseIds: kbIds,
  toolPrefix: 'wkg',
})

console.log('\n== plugin surface ==')
check('7 tools + 1 policy section registered', tools.size === 7 && sections.size === 1,
  `tools=${[...tools.keys()].join(',')} sections=${[...sections.keys()].join(',')}`)
const policy = sections.get('weknora-bydhs:policy')
check('policy section renders last (order 10500)', policy?.order === 10_500, `order=${policy?.order}`)
check('policy mentions the [K#] citation format', /\[K2\]/.test(policy?.text ?? ''))
check('policy names the citation checker tool', /wkg_check_citations/.test(policy?.text ?? ''))

console.log('\n== agent/pre-step: organizational question ==')
const preStep = listeners.get('agent/pre-step')?.[0]
check('agent/pre-step listener registered', typeof preStep === 'function')
const decision = await preStep({ agent: { id: 'verify-a1' }, turn: 1 }, async () => enter(question, 1))
const injected = messageText(decision)
check('evidence block injected into the entering message', /<kb-evidence/.test(injected))
const insufficient = /insufficient="true"/.test(injected)
const unavailable = /unavailable="true"/.test(injected)
console.log(`        retrieval outcome: ${insufficient ? 'insufficient (gate rejected everything)' : unavailable ? 'unavailable' : 'passages injected'}`)
check('decision fields preserved (startsRequestSeries)', decision.startsRequestSeries === true)
check('original message id preserved', decision.messages?.[0]?.id === 'm-1')
if (!insufficient && !unavailable) {
  check('injected evidence carries provenance', /knowledge_id: \S+ · chunk: \d+/.test(injected))
  check('injected block stays inside the character budget', injected.length <= 4000 + 1500, `${injected.length} chars`)
}

console.log('\n== agent/pre-step: same turn is not re-injected ==')
const again = await preStep({ agent: { id: 'verify-a1' }, turn: 1 }, async () => enter(question, 1))
check('second step of the same turn receives no second block', !/<kb-evidence/.test(messageText(again)))

console.log('\n== agent/pre-step: chit-chat is not grounded ==')
const chat = await preStep({ agent: { id: 'verify-a1' }, turn: 2 }, async () => enter('你好', 2))
check('greeting enters unchanged', !/<kb-evidence/.test(messageText(chat)))

console.log('\n== agent/request: temperature cap ==')
const requestHook = listeners.get('agent/request')?.[0]
const capped = await requestHook({ agent: { id: 'verify-a1' } }, async () => ({ temperature: 0.9 }))
check('grounded session temperature capped to 0.2', capped.temperature === 0.2, `got ${capped.temperature}`)
const untouched = await requestHook({ agent: { id: 'verify-cold' } }, async () => ({ temperature: 0.9 }))
check('ungrounded session temperature untouched', untouched.temperature === 0.9)

console.log('\n== tool: wkg_search quality gate ==')
const search = tools.get('wkg_search')
const exec = { signal: new AbortController().signal }
const hit = await search.execute({ query: question }, exec)
console.log(`        count=${hit.count} insufficient=${hit.insufficient} top_coverage=${hit.gate.top_coverage} dropped_by_coverage=${hit.gate.dropped_by_coverage} dropped_unprovable=${hit.gate.dropped_missing_provenance}`)
check('search returns gate diagnostics', typeof hit.gate?.top_coverage === 'number' && typeof hit.gate?.candidate_count === 'number')
check('count matches returned results', hit.count === hit.results.length)
if (hit.count > 0) {
  check('every returned passage is citable', hit.results.every((r) => r.knowledge_id !== '' && r.chunk_index >= 0))
  check('every returned passage passed the coverage gate', hit.results.every((r) => r.coverage >= hit.gate.min_coverage))
}

console.log('\n== tool: wkg_check_citations ==')
const checkCitations = tools.get('wkg_check_citations')
const goodAnswer = hit.count > 0 ? '点检周期为三个月 [K1]。' : '知识库中没有足够证据。'
const good = await checkCitations.execute({ answer: goodAnswer }, exec)
check('citation that matches the evidence verifies', good.ok === (hit.count > 0), `ok=${good.ok} notes=${good.notes}`)
const bad = await checkCitations.execute({ answer: '点检周期为三个月 [K99]。' }, exec)
check('fabricated marker is rejected', bad.ok === false && bad.citations[0]?.status === 'unknown_source')
const fabricated = await checkCitations.execute({ answer: '见 knowledge_id: deadbeef-0000-0000-0000-000000000000 chunk: 1' }, exec)
check('fabricated knowledge_id is rejected', fabricated.ok === false && fabricated.citations[0]?.status === 'not_in_evidence')

console.log('\n== negative control: off-topic query is gated ==')
const offTopic = await search.execute({ query: '今天北京天气怎么样，适合去哪里散步' }, exec)
console.log(`        count=${offTopic.count} insufficient=${offTopic.insufficient} top_coverage=${offTopic.gate.top_coverage}`)
check('off-topic query yields insufficient evidence', offTopic.insufficient === true && offTopic.count === 0)

console.log('\n== tool: wkg_list_knowledge_bases ==')
const listTool = tools.get('wkg_list_knowledge_bases')
const listed = await listTool.execute({}, exec)
check('lists at least one visible knowledge base', listed.count >= 1, `${listed.count} visible`)
if (kbIds.length > 0) {
  check('configured knowledge base appears in the list', listed.knowledge_bases.some((kb) => kb.id === kbIds[0]))
}

console.log('\n== tool: wkg_wiki_search / wkg_wiki_read ==')
const wikiSearch = tools.get('wkg_wiki_search')
// `summary` matches the per-document summary pages every wiki-enabled KB has;
// fall back to `concept` for wikis that only produced topic pages.
let wiki = await wikiSearch.execute({ query: 'summary', limit: 3 }, exec)
if (wiki.count === 0) wiki = await wikiSearch.execute({ query: 'concept', limit: 3 }, exec)
console.log(`        wiki pages matched: ${wiki.count} (failures: ${wiki.failures.length})`)
if (wiki.count === 0) {
  console.log('        NOTE: no wiki page matched — wiki may be disabled for this knowledge base; skipping wiki_read.')
} else {
  check('wiki_search returns slugs', wiki.pages.every((page) => page.slug !== ''))
  check('wiki_search keeps provenance metadata', wiki.pages.every((page) => typeof page.source_refs_count === 'number'))
  const first = wiki.pages[0]
  const page = await tools.get('wkg_wiki_read').execute(
    { slug: first.slug, knowledge_base_id: first.knowledge_base_id },
    exec,
  )
  check('wiki_read returns the page content', page.title !== '' && page.content !== '', `${page.page_type} · ${page.title}`)
  check('wiki_read keeps the page source references', Array.isArray(page.source_refs))
}

console.log('\n== logger ==')
for (const line of logs.slice(-6)) console.log(`  ${line}`)

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}: ${passed} passed, ${failed} failed`)
console.log(`(plugin dir: ${here})`)
process.exit(failed === 0 ? 0 : 1)
