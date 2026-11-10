/**
 * Optional: validate every tool's `parameters` and `output.schema` with the
 * Harness' own JSON-Schema validator.
 *
 * The validator lives in `@deepseek-ai/dsh-tools`, which is normally inside the
 * installed app bundle rather than on `NODE_PATH`. Point this script at it:
 *
 *   DSH_TOOLS_ENTRY="C:/path/to/@deepseek-ai/dsh-tools/lib/index.js" node scripts/verify-schemas.mjs
 *
 * When the module cannot be found the script reports SKIPPED and exits 0: the
 * unit tests do not depend on it, and a tester without the app bundle should
 * not see a failure.
 */

import { apply } from '../index.js'

const tools = new Map()
const ctx = {
  tools: { register(def) { tools.set(def.name, def) } },
  systemPrompt: { section() { return () => {} } },
  logger: { info() {}, warn() {} },
}

// No network is touched: the tools are only registered, never called.
await apply(ctx, { baseUrl: 'http://127.0.0.1:8080', apiKey: 'schema-check-key', knowledgeBaseIds: ['kb-1'] })

const entry = process.env.DSH_TOOLS_ENTRY
if (!entry) {
  console.log('SKIPPED: set DSH_TOOLS_ENTRY to @deepseek-ai/dsh-tools/lib/index.js to run this check.')
  process.exit(0)
}

let dsh
try {
  dsh = await import(`file:///${entry.replace(/\\/g, '/').replace(/^\/+/, '')}`)
} catch (error) {
  console.log(`SKIPPED: cannot import dsh-tools from ${entry}: ${error.message}`)
  process.exit(0)
}
if (typeof dsh.assertSupportedJsonSchema !== 'function') {
  console.log('SKIPPED: the imported module does not export assertSupportedJsonSchema.')
  process.exit(0)
}

let problems = 0
for (const [name, def] of tools) {
  for (const [label, schema] of [['parameters', def.parameters], ['output.schema', def.output?.schema]]) {
    try {
      dsh.assertSupportedJsonSchema(schema)
      console.log(`OK   ${name}.${label}`)
    } catch (error) {
      problems += 1
      console.log(`FAIL ${name}.${label}: ${error.message}`)
    }
  }
  if (typeof def.execute !== 'function') {
    problems += 1
    console.log(`FAIL ${name}.execute is missing`)
  }
}
console.log(problems === 0
  ? `\nSCHEMA CONFORMANCE: OK (${tools.size} tools)`
  : `\nSCHEMA PROBLEMS: ${problems}`)
process.exit(problems === 0 ? 0 : 1)
