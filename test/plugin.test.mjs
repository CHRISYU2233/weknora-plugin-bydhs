import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const HIT = {
  id: 'chunk-1',
  knowledge_id: '8f14e45f-ceea-467a-9c1a-2b3d4e5f6a7b',
  chunk_index: 3,
  knowledge_title: '设备手册',
  content: 'A-17 设备的点检周期为三个月，由设备科执行。',
  score: 0.91,
}

const OFF_TOPIC_HIT = {
  id: 'chunk-2',
  knowledge_id: '0c5f2a11-1111-4222-8333-444455556666',
  chunk_index: 1,
  knowledge_title: '无关文档',
  content: '今天天气很好，适合外出散步。',
  score: 0.55,
}

function makeContext() {
  const tools = new Map()
  const sections = new Map()
  const listeners = new Map()
  const ctx = {
    tools: { register(def) { tools.set(def.name, def) } },
    systemPrompt: { section(section) { sections.set(section.name, section); return () => sections.delete(section.name) } },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {}
    },
    effect(fn) { const dispose = fn(); return () => dispose?.() },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, tools, sections, listeners }
}

function stubFetch(hits, options = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (options.fail) throw new Error('ECONNREFUSED')
    if (String(url).includes('/knowledge-search')) {
      return new Response(JSON.stringify({ data: hits, meta: { rerank: { applied: true, outcome: 'ok' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return () => { globalThis.fetch = original }
}

function enterDecision(text, turn = 1) {
  return {
    kind: 'enter',
    startsRequestSeries: true,
    messages: [{ id: `m-${turn}`, role: 'user', content: [{ type: 'text', text }] }],
  }
}

async function load(options = {}) {
  const { ctx, tools, sections, listeners } = makeContext()
  await apply(ctx, {
    baseUrl: 'http://127.0.0.1:8080',
    apiKey: 'test-key',
    knowledgeBaseIds: ['kb-1'],
    ...options,
  })
  return { ctx, tools, sections, listeners }
}

const preStep = (listeners) => listeners.get('agent/pre-step')[0]
const requestHook = (listeners) => listeners.get('agent/request')[0]

test('registers the retrieval, wiki and diagnostic tools plus the policy section', async () => {
  const { tools, sections } = await load()
  assert.equal(tools.size, 7)
  for (const name of ['wkg_search', 'wkg_read', 'wkg_ask', 'wkg_check_citations', 'wkg_list_knowledge_bases', 'wkg_wiki_search', 'wkg_wiki_read']) {
    assert.ok(tools.has(name), `${name} registered`)
  }
  const section = sections.get('weknora-bydhs:policy')
  assert.equal(section.order, 10_500)
  assert.match(section.text, /<kb-evidence>/)
  assert.match(section.text, /\[K2\]/)
  assert.match(section.text, /wkg_check_citations/)
})

test('pre-step injects retrieved evidence into the entering user message', async () => {
  const restore = stubFetch([HIT])
  try {
    const { listeners } = await load()
    const decision = await preStep(listeners)(
      { agent: { id: 'a1' }, turn: 1 },
      async () => enterDecision('A-17 设备的点检周期是多少？'),
    )
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.startsRequestSeries, true, 'wrapper must preserve the decision fields')
    assert.equal(decision.messages.length, 1)
    const text = decision.messages[0].content.map((block) => block.text).join('\n')
    assert.match(text, /<kb-evidence turn="1" source="pre-step"/)
    assert.match(text, /\[K1\] 《设备手册》 · knowledge_id: 8f14e45f/)
    assert.match(text, /<kb-rule>/)
    assert.equal(decision.messages[0].id, 'm-1', 'message id must survive the injection')
  } finally {
    restore()
  }
})

test('the same turn is retrieved once, not on every step', async () => {
  const restore = stubFetch([HIT])
  try {
    const { listeners } = await load()
    const first = await preStep(listeners)({ agent: { id: 'a1' }, turn: 7 }, async () => enterDecision('A-17 点检周期是多少？', 7))
    assert.match(JSON.stringify(first.messages), /kb-evidence/)
    const second = await preStep(listeners)({ agent: { id: 'a1' }, turn: 7 }, async () => enterDecision('A-17 点检周期是多少？', 7))
    assert.doesNotMatch(JSON.stringify(second.messages), /kb-evidence/)
  } finally {
    restore()
  }
})

test('an off-topic hit becomes an insufficient-evidence block, not evidence', async () => {
  const restore = stubFetch([OFF_TOPIC_HIT])
  try {
    const { listeners } = await load()
    const decision = await preStep(listeners)(
      { agent: { id: 'a1' }, turn: 2 },
      async () => enterDecision('A-17 设备的点检周期是多少？', 2),
    )
    const text = JSON.stringify(decision.messages)
    assert.match(text, /insufficient=\\"true\\"/)
    assert.match(text, /不得凭记忆或常识回答/)
  } finally {
    restore()
  }
})

test('a retrieval failure injects an unavailable block instead of failing the step', async () => {
  const restore = stubFetch([], { fail: true })
  try {
    const { listeners } = await load()
    const base = enterDecision('A-17 设备的点检周期是多少？')
    const decision = await preStep(listeners)({ agent: { id: 'a1' }, turn: 3 }, async () => base)
    assert.equal(decision.kind, 'enter')
    const text = JSON.stringify(decision.messages)
    assert.match(text, /unavailable=\\"true\\"/)
    assert.match(text, /ECONNREFUSED/)
    assert.match(text, /不要把\\"检索失败\\"说成\\"知识库没有证据\\"/)
  } finally {
    restore()
  }
})

test('chit-chat is not grounded', async () => {
  const restore = stubFetch([HIT])
  try {
    const { listeners } = await load()
    const decision = await preStep(listeners)({ agent: { id: 'a1' }, turn: 4 }, async () => enterDecision('你好'))
    assert.equal(decision.messages[0].content.length, 1)
  } finally {
    restore()
  }
})

test('temperature is capped on grounded sessions only', async () => {
  const restore = stubFetch([HIT])
  try {
    const { listeners } = await load()
    // Before grounding: untouched.
    const before = await requestHook(listeners)({ agent: { id: 'cold' } }, async () => ({ temperature: 0.9 }))
    assert.equal(before.temperature, 0.9)
    // Ground one session, then cap it.
    await preStep(listeners)({ agent: { id: 'a1' }, turn: 5 }, async () => enterDecision('A-17 设备的点检周期是多少？', 5))
    const after = await requestHook(listeners)({ agent: { id: 'a1' } }, async () => ({ temperature: 0.9 }))
    assert.equal(after.temperature, 0.2)
    const lower = await requestHook(listeners)({ agent: { id: 'a1' } }, async () => ({ temperature: 0.05 }))
    assert.equal(lower.temperature, 0.05, 'a lower configured temperature is kept')
  } finally {
    restore()
  }
})

test('search reports the gate, and check_citations verifies against it', async () => {
  const restore = stubFetch([HIT, OFF_TOPIC_HIT])
  try {
    const { tools } = await load()
    const search = tools.get('wkg_search')
    const value = await search.execute({ query: 'A-17 设备的点检周期是多少' }, { signal: new AbortController().signal })
    assert.equal(value.count, 1)
    assert.equal(value.insufficient, false)
    assert.equal(value.results[0].marker, 'K1')
    assert.ok(value.gate.top_coverage > 0.34)

    const check = tools.get('wkg_check_citations')
    const good = await check.execute({ answer: '点检周期为三个月 [K1]。' }, { signal: new AbortController().signal })
    assert.equal(good.ok, true)
    const bad = await check.execute({ answer: '点检周期为三个月 [K4]。' }, { signal: new AbortController().signal })
    assert.equal(bad.ok, false)
    assert.equal(bad.citations[0].status, 'unknown_source')
  } finally {
    restore()
  }
})

test('a tool search that passes nothing through the gate reports insufficient', async () => {
  const restore = stubFetch([OFF_TOPIC_HIT])
  try {
    const { tools } = await load()
    const value = await tools.get('wkg_search').execute(
      { query: 'A-17 设备的点检周期是多少' },
      { signal: new AbortController().signal },
    )
    assert.equal(value.insufficient, true)
    assert.equal(value.count, 0)
  } finally {
    restore()
  }
})

test('with several knowledge bases one broken base does not empty the evidence page', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/knowledge-search')) {
      const body = JSON.parse(init?.body ?? '{}')
      const scope = body.knowledge_base_ids ?? []
      if (scope.includes('kb-bad')) throw new Error('HTTP 401 from kb-bad')
      return new Response(JSON.stringify({ data: [HIT], meta: { rerank: { applied: false, outcome: 'disabled' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const { listeners } = await load({ knowledgeBaseIds: ['kb-good', 'kb-bad'], perKbIsolation: true })
    const decision = await preStep(listeners)(
      { agent: { id: 'a1' }, turn: 1 },
      async () => enterDecision('A-17 设备的点检周期是多少？'),
    )
    const text = JSON.stringify(decision.messages)
    assert.match(text, /kb-evidence/)
    assert.match(text, /kb-bad: .*HTTP 401 from kb-bad/)
    assert.match(text, /证据不完整/)
  } finally {
    globalThis.fetch = original
  }
})

test('injectEvidence=false keeps the pre-step hook inert', async () => {
  const restore = stubFetch([HIT])
  try {
    const { listeners } = await load({ injectEvidence: false })
    const base = enterDecision('A-17 设备的点检周期是多少？')
    const decision = await preStep(listeners)({ agent: { id: 'a1' }, turn: 1 }, async () => base)
    assert.equal(decision.messages[0].content.length, 1)
  } finally {
    restore()
  }
})

test('policyOrder is configurable', async () => {
  const { sections } = await load({ policyOrder: 5100 })
  assert.equal(sections.get('weknora-bydhs:policy').order, 5100)
})

test('apply() survives a context without on/effect/credentials services', async () => {
  const tools = new Map()
  const ctx = {
    tools: { register(def) { tools.set(def.name, def) } },
    systemPrompt: { section() { return () => {} } },
    logger: { info() {} },
  }
  await apply(ctx, { baseUrl: 'http://127.0.0.1:8080', apiKey: 'k' })
  assert.equal(tools.size, 7)
})
