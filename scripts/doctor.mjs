/**
 * Environment doctor: check, in order, everything the plugin needs, and say
 * exactly what is missing. It never writes anything and never prints secrets.
 *
 *   node scripts/doctor.mjs [--query "a question your KB can answer"]
 *
 * Environment:
 *   WEKNORA_BASE_URL              default http://localhost:8080/api/v1
 *   WEKNORA_KNOWLEDGE_BASE_IDS    optional, comma separated
 *   WEKNORA_API_KEY               optional; falls back to ~/.dsh/.credentials.yaml
 *   DSH_TOOLS_ENTRY               optional; enables the JSON-Schema check
 *
 * Exit code: 0 when nothing failed (warnings are allowed), 1 otherwise.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const baseUrl = (process.env.WEKNORA_BASE_URL ?? 'http://localhost:8080/api/v1').replace(/\/+$/, '')
const kbIds = (process.env.WEKNORA_KNOWLEDGE_BASE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const queryIndex = process.argv.indexOf('--query')
const probeQuery = queryIndex >= 0 && process.argv[queryIndex + 1]
  ? process.argv[queryIndex + 1]
  : 'What is the inspection cycle for device A-17?'

let failures = 0
let warnings = 0
function line(status, name, detail = '') {
  const label = status === 'OK' ? 'OK  ' : status === 'WARN' ? 'WARN' : 'FAIL'
  console.log(`[${label}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (status === 'FAIL') failures += 1
  if (status === 'WARN') warnings += 1
}
function section(title) {
  console.log(`\n== ${title} ==`)
}

/* 1. Node ------------------------------------------------------------------ */
section('runtime')
const [major, minor] = process.versions.node.split('.').map(Number)
line(major > 20 || (major === 20 && minor >= 11) ? 'OK' : 'FAIL',
  'Node.js >= 20.11', `running ${process.versions.node}`)

/* 2. Plugin loads ---------------------------------------------------------- */
section('plugin load')
const tools = new Map()
const sections = new Map()
const ctx = {
  tools: { register(def) { tools.set(def.name, def) } },
  systemPrompt: { section(section) { sections.set(section.name, section); return () => {} } },
  logger: { info() {}, warn() {} },
}
let apply
try {
  ({ apply } = await import(`file:///${path.join(here, 'index.js').replace(/\\/g, '/')}`))
  await apply(ctx, {
    baseUrl,
    // A placeholder key is enough to register tools; the real key is checked below.
    apiKey: process.env.WEKNORA_API_KEY ?? 'doctor-placeholder',
    knowledgeBaseIds: kbIds,
  })
  line(tools.size >= 7 ? 'OK' : 'FAIL', 'tools registered', `${tools.size}: ${[...tools.keys()].join(', ')}`)
  line(sections.size === 1 ? 'OK' : 'FAIL', 'policy section registered', [...sections.keys()].join(', '))
} catch (error) {
  line('FAIL', 'plugin apply() failed', error.message)
}

/* 3. Credential ------------------------------------------------------------ */
section('credential')
function readKey() {
  if (process.env.WEKNORA_API_KEY) return { value: process.env.WEKNORA_API_KEY, source: 'WEKNORA_API_KEY env' }
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (!fs.existsSync(file)) return undefined
  const match = fs.readFileSync(file, 'utf8').match(/^\s*WEKNORA_API_KEY\s*:\s*(.+?)\s*$/m)
  if (!match) return undefined
  return { value: match[1].replace(/^['"]|['"]$/g, ''), source: '~/.dsh/.credentials.yaml' }
}
const key = readKey()
line(key ? 'OK' : 'FAIL', 'API key found', key ? `from ${key.source} (length ${key.value.length}, value not printed)` : 'set WEKNORA_API_KEY or add it to ~/.dsh/.credentials.yaml')

/* 4. Service reachable ----------------------------------------------------- */
section('service')
const origin = baseUrl.replace(/\/api\/v\d+$/, '')
let reachable = false
try {
  const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(8000) })
  reachable = response.ok
  line(response.ok ? 'OK' : 'WARN', 'GET /health', `HTTP ${response.status} at ${origin}`)
} catch (error) {
  line('FAIL', 'GET /health', `${origin} unreachable: ${error.message}`)
}

/* 5. Auth + knowledge bases ------------------------------------------------ */
section('authorization and scope')
const headers = { Accept: 'application/json' }
if (key) headers['X-API-Key'] = key.value
let visible = []
if (reachable) {
  try {
    const response = await fetch(`${baseUrl}/knowledge-bases`, { headers, signal: AbortSignal.timeout(15000) })
    if (response.ok) {
      const body = await response.json()
      visible = Array.isArray(body.data) ? body.data : []
      line(visible.length > 0 ? 'OK' : 'WARN', 'credential can see knowledge bases', `${visible.length} visible`)
    } else {
      const text = await response.text().catch(() => '')
      line('FAIL', 'GET /knowledge-bases', `HTTP ${response.status}: ${text.slice(0, 160)}`)
    }
  } catch (error) {
    line('FAIL', 'GET /knowledge-bases', error.message)
  }
}
if (kbIds.length > 0 && visible.length > 0) {
  for (const id of kbIds) {
    const found = visible.find((kb) => kb.id === id)
    line(found ? 'OK' : 'WARN', `configured knowledge base ${id}`, found ? (found.name ?? '') : 'not visible to this credential')
  }
}

/* 6. Documents in the configured knowledge base ---------------------------- */
section('data')
if (reachable && kbIds.length > 0 && key) {
  for (const id of kbIds) {
    try {
      const response = await fetch(`${baseUrl}/knowledge-bases/${encodeURIComponent(id)}/knowledge?page=1&page_size=5`, {
        headers,
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        line('WARN', `documents in ${id}`, `HTTP ${response.status}`)
        continue
      }
      const body = await response.json()
      const docs = Array.isArray(body.data) ? body.data : []
      line(docs.length > 0 ? 'OK' : 'WARN', `documents in ${id}`, `${docs.length} visible`)
    } catch (error) {
      line('WARN', `documents in ${id}`, error.message)
    }
  }
}

/* 7. Retrieval probe ------------------------------------------------------- */
section('retrieval probe')
if (reachable && key) {
  try {
    const response = await fetch(`${baseUrl}/knowledge-search`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: probeQuery, match_count: 3, ...(kbIds.length > 0 ? { knowledge_base_ids: kbIds } : {}) }),
      signal: AbortSignal.timeout(30000),
    })
    if (response.ok) {
      const body = await response.json()
      const hits = Array.isArray(body.data) ? body.data : []
      const rerank = body.meta?.rerank ?? {}
      line(hits.length > 0 ? 'OK' : 'WARN', 'search returns passages', `${hits.length} hit(s) for "${probeQuery}"`)
      if (rerank.outcome && rerank.outcome !== 'ok') {
        line('WARN', 'rerank stage', `outcome=${rerank.outcome} (retrieval may be keyword-only)`)
      }
    } else {
      const text = await response.text().catch(() => '')
      line('FAIL', 'POST /knowledge-search', `HTTP ${response.status}: ${text.slice(0, 160)}`)
    }
  } catch (error) {
    line('FAIL', 'POST /knowledge-search', error.message)
  }
}

/* 8. Wiki probe (optional) ------------------------------------------------- */
section('wiki probe (optional)')
if (reachable && key && kbIds.length > 0) {
  try {
    const response = await fetch(`${baseUrl}/knowledgebase/${encodeURIComponent(kbIds[0])}/wiki/search?q=summary&limit=3`, {
      headers,
      signal: AbortSignal.timeout(15000),
    })
    if (response.ok) {
      const body = await response.json()
      const pages = Array.isArray(body.pages) ? body.pages : []
      line(pages.length > 0 ? 'OK' : 'WARN', 'wiki pages found', `${pages.length} page(s) in ${kbIds[0]}`)
    } else {
      line('WARN', 'wiki search', `HTTP ${response.status} (wiki may be disabled)`)
    }
  } catch (error) {
    line('WARN', 'wiki search', error.message)
  }
}

/* 9. Optional JSON-Schema check -------------------------------------------- */
section('tool schemas (optional)')
const dshTools = process.env.DSH_TOOLS_ENTRY
if (!dshTools) {
  line('WARN', 'schema check skipped', 'set DSH_TOOLS_ENTRY to @deepseek-ai/dsh-tools/lib/index.js to enable')
} else {
  try {
    const module = await import(`file:///${dshTools.replace(/\\/g, '/').replace(/^\/+/, '')}`)
    let problems = 0
    for (const [name, def] of tools) {
      for (const schema of [def.parameters, def.output?.schema]) {
        try { module.assertSupportedJsonSchema(schema) } catch { problems += 1; line('FAIL', `${name} schema`) }
      }
    }
    line(problems === 0 ? 'OK' : 'FAIL', 'all tool schemas accepted', `${tools.size} tools`)
  } catch (error) {
    line('WARN', 'schema check skipped', error.message)
  }
}

/* Summary ------------------------------------------------------------------ */
console.log(`\n${failures === 0 ? 'DOCTOR: READY' : 'DOCTOR: NOT READY'} — ${failures} failure(s), ${warnings} warning(s)`)
if (failures > 0) {
  console.log('Fix the FAIL lines first; WARN lines usually mean "usable, but degraded".')
} else if (warnings > 0) {
  console.log('The plugin can load and retrieve; review the WARN lines for quality limits.')
} else {
  console.log('Everything checks out. Install the plugin into a DSH profile and ask a question.')
}
process.exit(failures === 0 ? 0 : 1)
