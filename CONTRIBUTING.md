# Contributing

Thanks for considering a contribution. This is a small, zero-dependency plugin; keeping it that
way is part of the design.

## Ground rules

- **No runtime dependencies.** Only Node.js built-ins (`fetch`, `AbortSignal`, `node:test`).
- **No build step.** The published files are the source files.
- **No secrets or private data.** Never commit real API keys, internal knowledge-base ids, host
  names, local absolute paths or customer documents. Use placeholders such as `<your-kb-id>`.
- **Stay read-only.** The plugin must not gain write paths (ingest, delete, chunk edits) without a
  design discussion; write access belongs to a separate, explicitly authorised plugin.

## Development

```powershell
cd WeKnora_plugin_byDHS

# unit tests (no network)
node --test

# optional: JSON-Schema validation with the harness validator
$env:DSH_TOOLS_ENTRY = 'C:/path/to/@deepseek-ai/dsh-tools/lib/index.js'
node scripts/verify-schemas.mjs

# offline end-to-end check (no WeKnora needed)
node scripts/mock-weknora.mjs --port 18090
$env:WEKNORA_BASE_URL='http://127.0.0.1:18090/api/v1'
$env:WEKNORA_API_KEY='mock-key'
$env:WEKNORA_KNOWLEDGE_BASE_IDS='mock-kb'
node scripts/verify-live.mjs --query "inspection cycle"
```

## Adding a tool

1. Add the definition in `tools.js` inside `createTools()`.
2. Declare **both** `parameters` and `output.schema`; only the JSON-Schema subset accepted by
   `assertSupportedJsonSchema` is allowed (`type`, `properties`, `required`,
   `additionalProperties`, `items`, `enum`, primitives).
3. Return values must satisfy the schema exactly — every required field must always be set
   (use `''` / `0` / `-1` placeholders instead of `null`).
4. Add a test in `test/` (stub `fetch`; no network).
5. Update `README.md`, `README.en.md` and `CHANGELOG.md`.

## Adding a config field

1. Add the default in `config.js` `DEFAULTS`.
2. Validate it in `resolveConfig()`; push a violation naming the field on bad input (never throw a
   bare `TypeError`).
3. Document it in the configuration table of both READMEs.
4. Add a config test.

## Pull requests

- One concern per PR; describe the user-visible behaviour change.
- Keep `node --test` green; CI runs Node 20, 22 and 24.
- If you change prompt text, explain the intended model behaviour change.

## Reporting bugs

Include: plugin version, DSH version, WeKnora version, the plugin row from `cordis.patch.yml`
(with the key removed), the `WeKnora_plugin_byDHS:` log lines, and the steps to reproduce.
For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
