# Security policy

## Scope

This plugin runs inside the DeepSeek Harness host process, talks to a WeKnora deployment over
HTTP(S), and is **read-only** by design. Security-relevant surfaces:

- the API key (resolved from the DSH credential store, never written to disk by the plugin)
- retrieved knowledge-base text (untrusted input that reaches the model as user-role content)
- the HTTP client (timeouts, cancellation, retries, error messages)

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. Report it privately to the maintainers
(for example through the repository's private security advisory feature) with:

1. a description of the issue and its impact,
2. the plugin version and the DSH/WeKnora versions,
3. reproduction steps or a proof of concept,
4. any suggested fix.

You will get an acknowledgement, and a coordinated disclosure once a fix is available.

## Design decisions that matter

| Risk | Mitigation |
| --- | --- |
| Key leakage | The key is read from `ctx.credentials` (or inline config) and only used in request headers; logs and error messages never include it |
| Prompt injection from knowledge-base text | Retrieved text is injected as **user-role** content, `<` is escaped to `\u003c` so it cannot close the `<kb-evidence>` framing tag, and the rule block states the passages are the only permitted source |
| Over-broad access | Use a KB-scoped, `retrieve`-only API key; the plugin never asks for `ingest` |
| SSRF via `baseUrl` | `baseUrl` is operator configuration, not model input; it must be an absolute http(s) URL |
| Denial of service from the server | Every request has a deadline; retries are bounded; `agent/pre-step` fails open so a broken deployment cannot wedge the conversation |
| Cross-session data leakage | The evidence ledger is scoped per agent; `check_citations` only reads the calling session's pages |

## Supported versions

Security fixes land on the latest minor release. Please upgrade before reporting an issue that
may already be fixed.
