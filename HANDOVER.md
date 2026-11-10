# Handover: giving this plugin to someone else

The plugin is only the adapter. Whoever tests it needs a reachable WeKnora, a key, and a
knowledge base with documents. This page lists exactly what to hand over and what the tester
must prepare.

## 1. What the sender provides

| Item | Example | Notes |
| --- | --- | --- |
| WeKnora base URL | `http://10.0.0.12:8090/api/v1` | Must be reachable **from the tester's machine**; `127.0.0.1` points at the tester's own machine |
| API key | `sk-...` | Capability `retrieve`; add `chat` if `ask` is needed. Prefer a KB-scoped key |
| Knowledge base id(s) | `<your-kb-id>` | Visible in the WeKnora knowledge-base page URL or via `list_knowledge_bases` |
| (Optional) sample documents | `samples/*.md` | Import them so the tester has something to retrieve |

## 2. What the tester prepares

- A DSH profile that can be edited (`cordis.patch.yml`)
- A DSH build with the `agent/pre-step`, `agent/request` and `systemPrompt.section` seams
  (DSH 0.2.x is known to work; see `COMPATIBILITY.md`)
- Node.js ≥ 20.11 on the host (the DSH runtime already provides one)

## 3. Configuration steps

### Step 1 — store the key

```yaml
# ~/.dsh/.credentials.yaml
refs:
  WEKNORA_API_KEY: sk-...
```

The desktop app does not inherit shell environment variables, so the credential store is the
reliable place.

### Step 2 — verify the environment before installing anything

```powershell
cd WeKnora_plugin_byDHS
$env:WEKNORA_BASE_URL = 'http://10.0.0.12:8090/api/v1'
$env:WEKNORA_KNOWLEDGE_BASE_IDS = '<your-kb-id>'
node scripts/doctor.mjs --query "a question your knowledge base answers"
```

`DOCTOR: READY` means the service, key, scope and data all check out. Fix the `FAIL` lines first;
`WARN` lines usually mean "usable but degraded".

### Step 3 — install

```text
plugin_manager(action="install_bundle", target="file:/path/to/WeKnora_plugin_byDHS")
```

or, on Windows, one command that also edits `package.json` and `cordis.patch.yml`:

```powershell
.\install.ps1 -Profile desktop -BaseUrl 'http://10.0.0.12:8090/api/v1' -KnowledgeBaseIds '<your-kb-id>'
```

### Step 4 — add or check the config row

```yaml
- id: WeKnora_plugin_byDHS
  name: "weknora-plugin-bydhs"
  disabled: false
  config:
    baseUrl: 'http://10.0.0.12:8090/api/v1'
    apiKeyRef: WEKNORA_API_KEY
    knowledgeBaseIds:
      - <your-kb-id>
```

A patch replaces the row's whole config; restate every field you keep.

### Step 5 — restart and check the log

```text
WeKnora_plugin_byDHS: registered wkg_search, wkg_read, wkg_ask, wkg_check_citations,
wkg_list_knowledge_bases, wkg_wiki_search, wkg_wiki_read + grounding policy ...
```

If instead you see `dsh: warning: 1 entry did not activate` plus `ConfigError`, the row's field
types are wrong (the message names each violation).

### Step 6 — acceptance in chat

1. Ask a question the knowledge base can answer → the answer carries `[K#]` and a citation list
2. Ask something the knowledge base cannot answer → the answer says there is not enough evidence
3. Check the log for `pre-step turn=1 candidates=... kept=... injected=...c`
4. Optionally call `check_citations` on a draft answer; a fabricated `[K9]` must be rejected

## 4. When it does not work

| Symptom | First thing to check |
| --- | --- |
| Plugin row does not activate | profile `package.json` bundles + `cordis.patch.yml` id, then field types |
| Loads but never injects | `injectEvidence`, whether the question is treated as chit-chat, host version |
| Every turn says "unavailable" | `baseUrl` reachability and key validity from the tester's network |
| Tool error about `rerank.xxx` | the tester installed an old version (0.1.x); upgrade to 0.4.0 |
| Retrieval returns unrelated documents | embedding/rerank models unavailable in WeKnora → keyword-only recall |

Run `node scripts/doctor.mjs` before guessing.
