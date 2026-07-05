# Wave 2 Synthesis Note

Date: 2026-07-05

Branch: `codex/wave-2-synthesis`

Base inspected: `codex/b1-confidential-oauth-hardening` (`52954c6`)

Source branches inspected:

- `codex/google-production-hardening` (`abed8b2`)
- `codex/local-model-runtime` (`6f5386f`)
- `codex/clerk-tauri-spike` (`f84590a`)

## Decisions

- Accepted Google hardening. Google remains a direct public-client PKCE path,
  independent of the confidential broker. Historical scopes are no longer
  merged into active grants, `include_granted_scopes` is removed, and missing
  required scope truth disables search/import/actions.
- Accepted the Ollama local runtime. It is a trusted literal-loopback
  integration, not general web fetch permission. Fable does not bundle, start,
  or download models. Synthesis tightened the endpoint to a clean loopback base
  URL and kept non-tool local prompts runnable while omitting tool schemas unless
  the selected model reports tool support.
- Accepted the Clerk ADR and config-gated spike boundary because the ADR
  identifies a production-capable public-client PKCE route. It remains disabled
  when Clerk config is missing. Production enablement is deferred pending live
  Clerk claim-shape validation, callback/deep-link packaging decisions,
  platform keyring CI, token revocation policy, and cloud/team verifier work.

## Deferred Or Rejected

- No Clerk identity is required for local files, memory, schedules, connector
  OAuth, BYOK providers, local Ollama, or solo workspaces.
- No connector OAuth was moved behind Clerk.
- No broad webview egress or CSP relaxation was added for Ollama or Clerk.
- No bundled llama.cpp/Ollama/model-download path was added.
- No live credentials, live OAuth sessions, provider payloads, prompts, or model
  responses were committed.

## Manual Validation Still Required

- Google Cloud OAuth app setup, consent verification, restricted-scope review,
  and live test-account validation.
- Live Ollama smoke test on a machine with a user-installed service and at least
  one local generation model.
- Live Clerk dev-instance validation before enabling production cloud/team
  identity.
- Confidential connector broker deployment and live provider OAuth validation.
