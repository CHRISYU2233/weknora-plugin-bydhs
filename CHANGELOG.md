# Changelog

All notable changes to this project are documented here.

## 0.4.0 — 2026-11-10

Open-source release: new tools, new deployment options, and a documentation set
for people who are not the author.

### Added

- **Wiki tools**: `wiki_search` and `wiki_read` expose the WeKnora Wiki pages
  (topic/entity pages generated from the knowledge base), so an agent can answer
  "what does the KB say about X" without going through the UI.
- **`list_knowledge_bases`**: discover which knowledge bases a credential can see,
  with id, name and document count.
- **`tenantId`** (`X-Tenant-ID`): platform-scoped API keys on multi-tenant
  deployments.
- **`extraHeaders`**: extra request headers for gateways/proxies in front of WeKnora.
- **`maxRetries`**: retry transient failures (429/5xx/network) with backoff;
  `0` disables retrying.
- **`maxWikiChars`**: character budget for one wiki page.
- `scripts/doctor.mjs`: ordered environment check with actionable OK/WARN/FAIL
  output (runtime, load, credential, service, scope, data, retrieval, wiki, schemas).
- `scripts/mock-weknora.mjs`: offline mock of the WeKnora REST surface, enough to
  run the full verification without a real deployment.
- `install.ps1`: one-click profile installer for Windows (copy, package.json,
  cordis.patch.yml, next steps).
- `samples/`: three fictional documents for testing retrieval, wiki and citations.
- `README.en.md`, `HANDOVER.md`, `COMPATIBILITY.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `.gitignore`, GitHub Actions CI.

### Changed

- The package is no longer `private`; `author` is the project, not a person.
- All sample identifiers, knowledge-base ids and local paths were replaced with
  placeholders so the package carries no personal or company information.
- `verify-live.mjs` now also checks `list_knowledge_bases`, `wiki_search` and
  `wiki_read` (28 checks in total).
- The default probe query is English; pass `--query` for another language.

### Tests

- 66 unit tests (`node --test`), including the new tools, tenant headers,
  slug encoding and retry behaviour.

## 0.3.0 — 2026-11-10

Packaging and rename; functionality unchanged from 0.2.1.

- Plugin renamed to **WeKnora_plugin_byDHS** (npm name `weknora-plugin-bydhs`,
  because npm does not allow capitals; `byDHS` means "by DeepSeek Harness").
- Policy section renamed to `weknora-bydhs:policy`.
- Added `README.md`, `TESTING.md`, `LICENSE`, `examples/`.
- Self-contained `scripts/verify-live.mjs` and `scripts/verify-schemas.mjs`.

## 0.2.1 — 2026-11-10

Fixes after an independent code review (2 blockers, 3 high, 5 medium, 6 low).

### Fixed (blockers)

- **`cordis.patch.yml` could fail the whole row**: an unquoted `!!js` ternary
  containing `: ` was truncated by YAML, the loader handed the plugin an object
  and `resolveConfig` threw `ConfigError`, so the row never activated. Every
  expression is now a quoted scalar, with a regression test.
- **Injected evidence was silently dropped**: the entering batch ends with the
  loop's own runtime-context snapshot (user role); appending to it meant the
  message was re-projected at commit time and the evidence disappeared, while the
  retrieval query became the runtime-context text. Evidence is now attached to
  the claimed user message from `payload.messages`, matched by id.

### Fixed (high)

- Dedupe by user-message id instead of turn number: mid-turn `steer`/`followup`
  messages are grounded too, and a reloaded session (turn counter restarts at 1)
  is no longer skipped.
- Inline citations no longer borrow the previous citation's chunk number.
- `<` in retrieved text is escaped (`\u003c`), so a document cannot close the
  `<kb-evidence>` block or forge citation markers.

### Fixed (medium)

- The evidence ledger is scoped per agent; `check_citations` only sees the
  calling session's pages.
- `meta.rerank` is projected onto the declared fields (an extra server field no
  longer turns a successful search into a tool error).
- `ask` keeps the configured knowledge-base scope on the agent route.
- `agent/pre-step` forwards `payload.signal`, so cancelling a step cancels the
  in-flight retrieval.
- A message whose content is not a block array is left untouched.

### Fixed (low)

- The injection budget covers the rule footer; `kept` is part of the tool output
  schema; `has_more` counts the chunks actually returned; the rule text follows
  `toolPrefix`; `enforce: false` no longer calls the policy mandatory; state has
  upper bounds; empty environment variables count as unset.

### Added

- Deterministic evidence gate (coverage + provenance) and three injection blocks
  (evidence / insufficient / unavailable).
- `check_citations` tool.
- Temperature cap on grounded sessions; per-KB failure isolation; configurable
  policy order.
- 57 unit tests and 22 live checks.

## 0.1.0 — 2026-11-09

First working version: three read-only tools (`search`, `read`, `ask`), a
system-prompt policy section, and API-key resolution from the DSH credential store.
