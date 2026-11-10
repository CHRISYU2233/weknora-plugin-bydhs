# Acceptance checklist

For the person testing the plugin. About 20–30 minutes, not counting WeKnora-side preparation.

## 0. What you need

- [ ] A DSH profile you can edit (`cordis.patch.yml`)
- [ ] A reachable WeKnora (v0.8+), e.g. `http://host:8090/api/v1`
- [ ] A **read-only** API key (`retrieve`; add `chat` for `ask`)
- [ ] At least one knowledge base with a few documents visible to that key
- [ ] The key stored in the DSH credential store: `~/.dsh/.credentials.yaml` → `refs.WEKNORA_API_KEY`

## 1. Five-minute smoke test (no install yet)

```powershell
cd WeKnora_plugin_byDHS

# 1.1 unit tests: no network, expect 66/66
node --test

# 1.2 environment doctor: expect DOCTOR: READY (WARN is usually fine)
$env:WEKNORA_BASE_URL = 'http://your-host:8090/api/v1'
$env:WEKNORA_KNOWLEDGE_BASE_IDS = '<your-kb-id>'
node scripts/doctor.mjs --query "a question your knowledge base answers"

# 1.3 live integration: expect ALL CHECKS PASSED: 28 passed, 0 failed
node scripts/verify-live.mjs --query "a question your knowledge base answers"
```

- [ ] `node --test` is green
- [ ] doctor says READY
- [ ] live check is green; note the `retrieval outcome` line (passages / insufficient / unavailable)
- [ ] repeat with a question the knowledge base definitely cannot answer → `insufficient=true`, `count=0`

No WeKnora available? Use the offline mock instead:

```powershell
node scripts/mock-weknora.mjs --port 18090
# second terminal
$env:WEKNORA_BASE_URL='http://127.0.0.1:18090/api/v1'
$env:WEKNORA_API_KEY='mock-key'
$env:WEKNORA_KNOWLEDGE_BASE_IDS='mock-kb'
node scripts/verify-live.mjs --query "inspection cycle"
```

## 2. Install

- [ ] `plugin_manager(action="install_bundle", target="file:<absolute path>")`, or `.\install.ps1 -Profile <name>`, or a manual copy
- [ ] the profile `cordis.patch.yml` has the `id: WeKnora_plugin_byDHS` row (see `examples/`)
- [ ] after restart/reload the log shows: `WeKnora_plugin_byDHS: registered ...`
- [ ] there is no `dsh: warning: 1 entry did not activate`

## 3. Functional acceptance

### 3.1 Tools exist

- [ ] the agent can see `wkg_search`, `wkg_read`, `wkg_ask`, `wkg_check_citations`, `wkg_list_knowledge_bases`, `wkg_wiki_search`, `wkg_wiki_read`
- [ ] `wkg_search` returns `knowledge_id` / `chunk_index` / `coverage` / `marker` (`[K1]`) and a `gate` object
- [ ] `wkg_list_knowledge_bases` lists the configured knowledge base
- [ ] `wkg_read` pages through one document

### 3.2 Injected retrieval (core)

- [ ] new session, ask a question the knowledge base answers
- [ ] the answer carries `[K1]`-style markers and an end-of-answer citation list
- [ ] the log shows `pre-step turn=... candidates=... kept=... injected=...c`
- [ ] continuing the same turn does not inject the evidence again

### 3.3 Insufficient evidence

- [ ] ask something the knowledge base clearly cannot answer (e.g. a made-up device id)
- [ ] expected: the answer says there is not enough evidence and what is missing; **no invented values**
- [ ] the log shows `insufficient=true` for that turn

### 3.4 Retrieval failure

- [ ] temporarily point `baseUrl` at a wrong port (or stop WeKnora), ask a question
- [ ] expected: the answer says retrieval is unavailable and repeats the reason; it must not say "no evidence"
- [ ] restore the configuration

### 3.5 Citation check

- [ ] retrieve once, then call `wkg_check_citations` with a real `[K1]` → `ok=true`
- [ ] with `[K9]` → `ok=false`, status `unknown_source`
- [ ] with a fabricated `knowledge_id` → `not_in_evidence`

### 3.6 Wiki tools (when wiki is enabled)

- [ ] `wkg_wiki_search` with a term from a page title returns pages with slugs
- [ ] `wkg_wiki_read` with that slug returns content and `source_refs`
- [ ] if the knowledge base has wiki disabled: `wiki_search` returns 0 and the rest still works

### 3.7 Multiple knowledge bases (optional)

- [ ] configure two knowledge bases, one intentionally wrong/unreachable
- [ ] expected: results from the healthy one still appear, and the evidence block notes `（注意：以下知识库本轮检索失败…）`

### 3.8 Temperature and policy

- [ ] grounded sessions show noticeably less random output (temperature ≤ 0.2)
- [ ] the system prompt contains the `weknora-bydhs:policy` section (after the persona suffix)

## 4. Negative controls (make sure it is not over-triggering)

- [ ] "hello" / "thanks" → no evidence injected
- [ ] pure code syntax (e.g. "how do I undo a git commit") → no evidence injected
- [ ] general knowledge (e.g. "how far is the moon") → may be answered without retrieval

## 5. Record sheet

| Item | Result | Notes |
| --- | --- | --- |
| DSH version / profile | | |
| WeKnora version / URL | | |
| Unit tests (66) | | |
| doctor | | |
| live checks (28) | | |
| Injected retrieval | | |
| Insufficient behaviour | | |
| Retrieval failure behaviour | | |
| Citation check | | |
| Wiki tools | | |
| Multi-KB isolation | | |
| Negative controls | | |
| Open issues | | |

## 6. What to send when something fails

1. plugin version (`package.json`) and DSH version;
2. the plugin row from `cordis.patch.yml` (**remove the key**);
3. the `WeKnora_plugin_byDHS:` log lines (info and warn);
4. the `wkg_search` result (knowledge ids and text may be redacted);
5. reproduction steps: question, expected behaviour, actual behaviour.
