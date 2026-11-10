/**
 * Offline WeKnora mock — enough of the REST surface for the plugin to run
 * end to end without a real deployment. Useful for demos, CI and for checking
 * the plugin's behaviour (evidence injection, gate, citation check) before a
 * WeKnora instance is available.
 *
 *   node scripts/mock-weknora.mjs [--port 18090]
 *
 * Then point the plugin (or the verification scripts) at it:
 *
 *   WEKNORA_BASE_URL=http://127.0.0.1:18090/api/v1
 *   WEKNORA_API_KEY=mock-key
 *   node scripts/verify-live.mjs --query "inspection cycle"
 *
 * The mock requires a non-empty X-API-Key so the auth path is exercised too.
 * It serves three documents: two on-topic and one deliberately off-topic, so
 * the evidence gate has something to reject.
 */

import http from 'node:http'

const portArgIndex = process.argv.indexOf('--port')
const port = portArgIndex >= 0 && process.argv[portArgIndex + 1]
  ? Number(process.argv[portArgIndex + 1])
  : Number(process.env.MOCK_PORT ?? 18090)

const KB_ID = 'mock-kb'

const CHUNKS = [
  {
    id: 'mock-chunk-1',
    knowledge_id: 'mock-doc-1',
    knowledge_title: 'Equipment Inspection Handbook',
    knowledge_filename: 'equipment-inspection.md',
    chunk_index: 0,
    score: 0.92,
    content: 'The inspection cycle for device A-17 is 36 hours, performed by the equipment team and recorded in the inspection log.',
  },
  {
    id: 'mock-chunk-2',
    knowledge_id: 'mock-doc-2',
    knowledge_title: 'Inspection Record Policy',
    knowledge_filename: 'inspection-records.md',
    chunk_index: 1,
    score: 0.81,
    content: 'Inspection records must be archived before the 5th of each month; anomalies are reported within 24 hours.',
  },
  {
    id: 'mock-chunk-3',
    knowledge_id: 'mock-doc-3',
    knowledge_title: 'Unrelated Note',
    knowledge_filename: 'weather.md',
    chunk_index: 0,
    score: 0.55,
    content: 'The weather was pleasant today, good for a walk outside.',
  },
]

const WIKI_PAGE = {
  id: 'mock-wiki-1',
  knowledge_base_id: KB_ID,
  slug: 'concept/inspection-cycle',
  title: 'Inspection Cycle',
  page_type: 'concept',
  status: 'published',
  summary: 'How often device A-17 must be inspected and where the records go.',
  content: '# Inspection Cycle\n\nThe inspection cycle for device A-17 is 36 hours.\n\nRecords are archived before the 5th of each month.',
  version: 2,
  source_refs: ['mock-doc-1|Equipment Inspection Handbook', 'mock-doc-2|Inspection Record Policy'],
  in_links: ['summary/mock-doc-1'],
  out_links: ['entity/device-a-17'],
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function sse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const apiKey = request.headers['x-api-key']
  console.log(`${request.method} ${path}${url.search}`)

  if (path === '/health') {
    json(response, 200, { status: 'ok' })
    return
  }
  if (path === '/') {
    json(response, 200, { name: 'mock-weknora', knowledge_bases: [KB_ID] })
    return
  }
  if (!path.startsWith('/api/v1/')) {
    json(response, 404, { error: 'not found' })
    return
  }
  if (typeof apiKey !== 'string' || apiKey === '') {
    json(response, 401, { error: 'missing X-API-Key' })
    return
  }

  const rest = path.slice('/api/v1'.length)

  if (rest === '/knowledge-bases' && request.method === 'GET') {
    json(response, 200, {
      data: [{ id: KB_ID, name: 'Mock Knowledge Base', description: 'Offline demo dataset', chunk_count: CHUNKS.length }],
    })
    return
  }
  if (rest === '/knowledge-search' && request.method === 'POST') {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      let query = ''
      try { query = JSON.parse(body).query ?? '' } catch { /* keep empty */ }
      // A very small keyword filter: return everything, let the plugin's gate decide.
      json(response, 200, {
        data: CHUNKS,
        meta: { rerank: { applied: false, outcome: 'disabled', candidate_count: CHUNKS.length, result_count: CHUNKS.length } },
        echo_query: query,
      })
    })
    return
  }
  if (rest.startsWith('/chunks/') && request.method === 'GET') {
    const knowledgeId = decodeURIComponent(rest.slice('/chunks/'.length))
    const chunks = CHUNKS.filter((chunk) => chunk.knowledge_id === knowledgeId)
      .map((chunk) => ({ chunk_index: chunk.chunk_index, content: chunk.content }))
    json(response, 200, { data: chunks, total: chunks.length })
    return
  }
  if (rest === '/sessions' && request.method === 'POST') {
    json(response, 200, { data: { id: 'mock-session-1' } })
    return
  }
  if ((rest.startsWith('/knowledge-chat/') || rest.startsWith('/agent-chat/')) && request.method === 'POST') {
    sse(response, [
      { response_type: 'references', knowledge_references: CHUNKS.slice(0, 2).map((chunk) => ({
        knowledge_id: chunk.knowledge_id,
        knowledge_title: chunk.knowledge_title,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
      })) },
      { response_type: 'answer', content: 'The inspection cycle for device A-17 is 36 hours.' },
      { response_type: 'complete' },
    ])
    return
  }
  if (rest.startsWith('/knowledgebase/') && rest.includes('/wiki/search')) {
    json(response, 200, { pages: [WIKI_PAGE], total: 1 })
    return
  }
  if (rest.startsWith('/knowledgebase/') && rest.includes('/wiki/pages/')) {
    json(response, 200, WIKI_PAGE)
    return
  }

  json(response, 404, { error: `mock has no route for ${request.method} ${rest}` })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-weknora listening on http://127.0.0.1:${port}`)
  console.log(`  baseUrl: http://127.0.0.1:${port}/api/v1`)
  console.log('  any non-empty X-API-Key is accepted')
  console.log(`  knowledge base: ${KB_ID} (${CHUNKS.length} passages, 1 off-topic, 1 wiki page)`)
})
