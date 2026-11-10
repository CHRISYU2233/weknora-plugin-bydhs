import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const KB_A = { id: 'kb-a', name: '设备知识库', description: '设备规程', chunk_count: 12 }
const KB_B = { id: 'kb-b', name: '差旅制度', description: '', chunk_count: 3 }

const WIKI_PAGE = {
  id: 'p1',
  slug: 'concept/dian-jian-zhou-qi',
  title: '点检周期',
  page_type: 'concept',
  status: 'published',
  summary: '设备点检周期与执行要求',
  content: '# 点检周期\n\n设备 A-17 的点检周期为 36 小时。',
  version: 3,
  source_refs: ['doc-1|设备手册'],
  in_links: ['summary/doc-1'],
  out_links: ['entity/a-17'],
}

function makeContext() {
  const tools = new Map()
  const sections = new Map()
  const listeners = new Map()
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
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, tools, sections, listeners }
}

function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    const result = await handler(String(url), init ?? {}, calls.length)
    if (result instanceof Response) return result
    const status = result?.__status ?? 200
    const body = result?.__body ?? result ?? { data: [] }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { restore: () => { globalThis.fetch = original }, calls }
}

async function load(options = {}) {
  const { ctx, tools, sections, listeners } = makeContext()
  await apply(ctx, {
    baseUrl: 'http://127.0.0.1:8080',
    apiKey: 'test-key',
    knowledgeBaseIds: ['kb-a'],
    ...options,
  })
  return { tools, sections, listeners }
}

const exec = (agent) => ({ signal: new AbortController().signal, ...(agent ? { agent } : {}) })

test('list_knowledge_bases returns ids, names and counts, and filters', async () => {
  const stub = stubFetch((url) => (url.endsWith('/knowledge-bases')
    ? { data: [KB_A, KB_B] }
    : { data: [] }))
  try {
    const { tools } = await load()
    const tool = tools.get('wkg_list_knowledge_bases')
    const all = await tool.execute({}, exec())
    assert.equal(all.count, 2)
    assert.deepEqual(all.knowledge_bases[0], { id: 'kb-a', name: '设备知识库', description: '设备规程', chunk_count: 12 })
    const filtered = await tool.execute({ query: '差旅' }, exec())
    assert.equal(filtered.count, 1)
    assert.equal(filtered.knowledge_bases[0].id, 'kb-b')
    assert.match(tool.output.render({}, all).map((b) => b.text).join('\n'), /kb-a · 设备知识库 · 12 chunk/)
  } finally {
    stub.restore()
  }
})

test('wiki_search maps pages and clips summary/snippet', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/wiki/search')) return { pages: [WIKI_PAGE], total: 1 }
    return { data: [] }
  })
  try {
    const { tools } = await load()
    const tool = tools.get('wkg_wiki_search')
    const value = await tool.execute({ query: '点检周期' }, exec())
    assert.equal(value.count, 1)
    assert.equal(value.pages[0].knowledge_base_id, 'kb-a')
    assert.equal(value.pages[0].slug, 'concept/dian-jian-zhou-qi')
    assert.equal(value.pages[0].source_refs_count, 1)
    assert.equal(value.failures.length, 0)
    assert.match(tool.output.render({ query: '点检周期' }, value).map((b) => b.text).join('\n'), /concept\/dian-jian-zhou-qi/)
  } finally {
    stub.restore()
  }
})

test('wiki_search fans out over knowledge bases and isolates one failure', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/knowledgebase/kb-b/wiki/search')) return { __status: 401, __body: { error: 'unauthorized' } }
    if (url.includes('/wiki/search')) return { pages: [WIKI_PAGE] }
    return { data: [] }
  })
  try {
    const { tools } = await load({ knowledgeBaseIds: ['kb-a', 'kb-b'] })
    const value = await tools.get('wkg_wiki_search').execute({ query: '点检' }, exec())
    assert.equal(value.count, 1)
    assert.equal(value.failures.length, 1)
    assert.equal(value.failures[0].kb_id, 'kb-b')
    assert.match(value.failures[0].error, /401/)
  } finally {
    stub.restore()
  }
})

test('wiki_search resolves every visible knowledge base when none is configured', async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith('/knowledge-bases')) return { data: [KB_A] }
    if (url.includes('/wiki/search')) return { pages: [WIKI_PAGE] }
    return { data: [] }
  })
  try {
    const { tools } = await load({ knowledgeBaseIds: [] })
    const value = await tools.get('wkg_wiki_search').execute({ query: '点检' }, exec())
    assert.equal(value.count, 1)
    assert.equal(value.pages[0].knowledge_base_id, 'kb-a')
  } finally {
    stub.restore()
  }
})

test('wiki_read returns the page, its sources and a truncation flag', async () => {
  const longPage = { ...WIKI_PAGE, content: '长'.repeat(600) }
  const stub = stubFetch((url) => {
    if (url.includes('/wiki/pages/concept/dian-jian-zhou-qi')) return longPage
    return { data: [] }
  })
  try {
    const { tools } = await load()
    const tool = tools.get('wkg_wiki_read')
    const value = await tool.execute({ slug: 'concept/dian-jian-zhou-qi' }, exec())
    assert.equal(value.title, '点检周期')
    assert.equal(value.page_type, 'concept')
    assert.equal(value.version, 3)
    assert.deepEqual(value.source_refs, ['doc-1|设备手册'])
    assert.equal(value.truncated, false)

    const clipped = await tool.execute({ slug: 'concept/dian-jian-zhou-qi', max_chars: 200 }, exec())
    assert.equal(clipped.truncated, true)
    assert.ok(clipped.content.length <= 200)
  } finally {
    stub.restore()
  }
})

test('wiki_read encodes every slug segment but keeps the separators', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('/wiki/pages/')) return WIKI_PAGE
    return { data: [] }
  })
  try {
    const { tools } = await load()
    await tools.get('wkg_wiki_read').execute({ slug: 'concept/点检 周期' }, exec())
    const called = stub.calls.find((call) => call.url.includes('/wiki/pages/'))
    assert.ok(called.url.includes('concept/'), called.url)
    assert.ok(called.url.includes('%E7%82%B9%E6%A3%80'), called.url)
    assert.ok(!called.url.includes('concept%2F'), 'separators must stay slashes')
  } finally {
    stub.restore()
  }
})

test('tenantId and extraHeaders are sent on every request', async () => {
  const stub = stubFetch(() => ({ data: [KB_A] }))
  try {
    const { tools } = await load({
      tenantId: '42',
      extraHeaders: { 'X-Gateway-Token': 'abc' },
    })
    await tools.get('wkg_list_knowledge_bases').execute({}, exec())
    const headers = stub.calls[0].init.headers ?? {}
    assert.equal(headers['X-Tenant-ID'], '42')
    assert.equal(headers['X-Gateway-Token'], 'abc')
    assert.equal(headers['X-API-Key'], 'test-key')
  } finally {
    stub.restore()
  }
})

test('a transient 503 is retried once by default', async () => {
  const stub = stubFetch((url, init, count) => {
    if (url.includes('/knowledge-search')) {
      return count === 1 ? { __status: 503, __body: { error: 'temporarily unavailable' } } : { data: [] }
    }
    return { data: [] }
  })
  try {
    const { tools } = await load()
    const value = await tools.get('wkg_search').execute({ query: '点检周期' }, exec())
    assert.equal(value.count, 0)
    const searchCalls = stub.calls.filter((call) => call.url.includes('/knowledge-search'))
    assert.equal(searchCalls.length, 2)
  } finally {
    stub.restore()
  }
})

test('maxRetries: 0 disables retrying', async () => {
  const stub = stubFetch(() => ({ __status: 503, __body: { error: 'down' } }))
  try {
    const { tools } = await load({ maxRetries: 0 })
    await assert.rejects(
      () => tools.get('wkg_search').execute({ query: '点检周期' }, exec()),
      /503/,
    )
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})
