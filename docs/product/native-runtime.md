# Native Agent Runtime

Fable's native API path supports OpenAI-compatible, Anthropic, and Gemini wire
formats while keeping provider credentials inside the Rust boundary.

## Model availability

Connected providers are queried through their model-list endpoints. Discovery
has five explicit outcomes: `success`, `empty`, `unsupported`, `offline`, and
`failed`. Only a successful response may make an omitted catalogue model
unavailable; offline, unsupported, and failed discovery retain the curated
fallback instead of pretending the provider returned an empty list.

Embedding, moderation, audio, image, and other non-generation models are
filtered. A newly discovered model remains visible but disabled until Fable has
an execution-capability contract for it. Provider pagination, model counts, page
counts, and response bytes are bounded.

## Settings provider UX states

The Settings → Providers view reflects real runtime state instead of optimistic
copy. Each connected API-key provider row carries a per-provider model-discovery
lifecycle layered on top of its auth state (not a new auth state):

- `loading` — a spinner; the Refresh/Retry control is disabled mid-flight.
- `success` — the connected badge reads "Connected"; models are shown.
- `empty` — the account surfaced no usable models; the hint points at the plan
  or billing, never at the key.
- `offline` / `failed` — "connected but degraded": the key is fine, the model
  list just couldn't be confirmed. Recoverable via the per-row Refresh action,
  which re-runs discovery without reconnecting.
- `unsupported` — the provider exposes no model list; the user picks manually.

Connect outcomes distinguish a **missing** key ("No API key stored… add a key",
signalled by the boundary's missing-key message) from a **rejected** key ("key
was rejected or has expired"). Transient outcomes never mention the key, and no
secret or stack trace is ever surfaced.

## Runs and recovery

Each run checkpoints its provider, model, active thread, transcript, usage,
pending approvals, and user/assistant/tool exchanges. On restart, in-flight
runs become `interrupted`; the chat surface offers an explicit safe retry from
the durable user prompt. Retry creates a new run with a `parentRunId`. It never
replays a prior tool result or side effect.

Terminal states are exclusive: completed, cancelled, failed, or interrupted.
Provider/parser errors cannot subsequently overwrite a run as completed.
Provider token counts are retained as reported. Dollar cost is labelled
estimated because it is calculated from Fable's maintained price table.

## Tool safety

Tool calls are bounded by rounds, call count, argument size, output size, and
strict JSON shape. Unknown tools, malformed identifiers, replayed call IDs, and
oversized payloads fail before approval or execution.

Approval IDs include the current run ID and provider. Rust then requires the
exact persisted request fingerprint, tool policy, argument preview, workspace
confinement, an unconsumed permit, and a fresh execution timestamp immediately
before dispatch. Transport retries happen only before a successful response;
an interrupted stream or completed tool side effect is not replayed
automatically.

## External requirements

Live execution requires a user-supplied API key in OS secure storage and
provider network access. Tests use fixtures and mocks; they do not validate
provider account entitlements or live billing.
