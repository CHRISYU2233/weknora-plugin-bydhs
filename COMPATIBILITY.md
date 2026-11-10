# Compatibility

## Tested combinations

| Component | Version tested | Notes |
| --- | --- | --- |
| DeepSeek Harness (DSH) | 0.2.x | Uses `agent/pre-step`, `agent/request`, `ctx.systemPrompt.section()`, `ctx.tools.register()` |
| WeKnora | v0.9.0 | REST API: `/knowledge-search`, `/chunks/:id`, `/sessions`, `/knowledge-chat/:id`, `/agent-chat/:id`, `/knowledgebase/:kb/wiki/*` |
| Node.js | 20.11, 22, 24 | Zero runtime dependencies; the test runner needs `node:test` |
| OS | Windows (primary), Linux/macOS (expected) | The plugin itself is platform-neutral; only `install.ps1` is Windows-specific |

## Host seams this plugin relies on

| Seam | Used for | Behaviour without it |
| --- | --- | --- |
| `agent/pre-step` | Evidence injection, turn dedupe, failure blocks | Tools still register, but nothing is injected; the policy section asks the model to search |
| `agent/request` | Temperature cap on grounded sessions | No cap applied |
| `ctx.systemPrompt.section()` | Policy section (`weknora-bydhs:policy`, order 10500) | Plugin fails to load (required service) |
| `ctx.tools.register()` | The seven tools | Plugin fails to load (required service) |
| `ctx.credentials.resolve()` | `apiKeyRef` resolution | Use inline `apiKey` instead |

The plugin is written against the public Cordis service surface only. It does not import any
`@deepseek-ai/*` package, so it does not pin a harness version.

## WeKnora capabilities used

| Endpoint | Used by | Optional |
| --- | --- | --- |
| `POST /knowledge-search` | `search`, pre-step injection | no |
| `GET /chunks/:knowledge_id` | `read` | no |
| `POST /sessions`, `POST /knowledge-chat/:id`, `POST /agent-chat/:id` | `ask` | yes (needs `chat` capability) |
| `GET /knowledge-bases` | `list_knowledge_bases`, wiki scope fallback | no |
| `GET /knowledgebase/:kb/wiki/search` | `wiki_search` | yes (wiki must be enabled) |
| `GET /knowledgebase/:kb/wiki/pages/:slug` | `wiki_read` | yes (wiki must be enabled) |

## API-key capabilities

| Capability | Needed for |
| --- | --- |
| `retrieve` | `search`, `read`, pre-step injection, wiki tools |
| `chat` | `ask` |
| `ingest` | **not used** — the plugin is read-only |

## Degraded modes

| Condition | Effect |
| --- | --- |
| Embedding or rerank model unavailable | Retrieval falls back to keyword recall; `search` reports `rerank.outcome=model_error`; the coverage gate still works |
| Wiki disabled on the knowledge base | `wiki_search` returns no pages; other tools unaffected |
| WeKnora unreachable | Pre-step injects an `unavailable` block; tools raise errors the model can report |
| Old DSH without `agent/pre-step` | Tools register, policy section loads, but no evidence injection |
