# Native Agent Runtime

Fable's native path supports OpenAI-compatible, Anthropic, and Gemini wire
formats. Rust owns credential persistence, endpoint policy, HTTP/TLS egress,
timeouts, retries, streaming, and cancellation. TypeScript owns the bounded
multi-round agent loop and provider request/response shaping.

## Setup and Credentials

- Remote fixed profiles use a user-supplied API key. After submission, the key
  is stored through the OS keyring boundary (with an in-memory test/headless
  fallback), is never returned to the frontend, and is injected into request
  headers only inside Rust.
- Ollama is the local exception: Fable stores only a local connection marker
  and connects to the existing loopback service at `localhost:11434`. Fable
  does not install Ollama or download/manage models.
- Custom stores a versioned OpenAI-compatible base URL, explicit model ID, and
  optional bearer key in the same secure credential record. HTTPS is required for remote hosts;
  plain HTTP is accepted only for `localhost` or another loopback address.
  User information, query strings, and fragments are rejected in the base URL.
- Credential verification calls a bounded model-list endpoint where the
  provider exposes one. Providers without a compatible list endpoint return an
  explicit `unsupported` discovery state and continue with curated models; this
  is not evidence that a key or account entitlement was validated.

## Implemented Provider Catalog

"Implemented" below means the endpoint profile, credential boundary, request
shaping, streaming path, and tests exist in the repository. No live provider
credentials, paid plans, regional availability, or billing behavior were
externally validated in this checkout.

| Provider | Runtime profile | Connection | Model discovery |
| --- | --- | --- | --- |
| OpenAI | OpenAI-compatible | API key | Dynamic |
| Anthropic | Anthropic Messages | API key | Dynamic |
| Gemini | Google AI Gemini | API key | Dynamic |
| xAI | OpenAI-compatible | API key | Dynamic |
| OpenRouter | OpenAI-compatible | API key | Dynamic |
| DeepSeek | OpenAI-compatible | API key | Dynamic |
| Z.AI | OpenAI-compatible | API key | Curated fallback |
| MiniMax | OpenAI-compatible | API key | Dynamic |
| Alibaba Model Studio | OpenAI-compatible | API key | Curated fallback |
| Fireworks AI | OpenAI-compatible | API key | Curated fallback |
| Hugging Face | OpenAI-compatible router | API token | Dynamic |
| Kimi Code membership | OpenAI-compatible coding endpoint | Membership API key | Fixed `kimi-for-coding` model |
| Moonshot (Kimi API) | OpenAI-compatible | API key | Dynamic |
| Mistral AI | OpenAI-compatible | API key | Dynamic |
| Meta Llama API | OpenAI-compatible | API key; availability-limited | Dynamic when account access exists |
| Ollama | OpenAI-compatible loopback | Existing local service; no API key | Dynamic from local service |
| Perplexity | OpenAI-compatible | API key | Curated fallback |
| Tencent TokenHub | OpenAI-compatible | API key | Curated fallback |
| Xiaomi MiMo | OpenAI-compatible | API key | Curated fallback |
| Groq | OpenAI-compatible | API key | Dynamic |
| Together AI | OpenAI-compatible | API key | Dynamic |
| Cerebras | OpenAI-compatible | API key | Dynamic |
| Custom | OpenAI-compatible | Validated base URL, model ID, optional bearer key | Explicit configured model ID |

All three wire profiles implement text completion, streaming, approval-gated
tool/function calls, bounded retries, and cancellation. The native payload path
does not yet support image/file attachments. OpenAI-compatible providers can
still differ in model naming and tool-call behavior, so repository conformance
tests are not a substitute for live-provider validation.

## Local Loopback Runtime

Ollama is integrated as a separate `local-loopback` backend, not as an API-key
provider. The Rust boundary probes and streams only to an `http` literal
loopback base URL, defaulting to `http://127.0.0.1:11434`. Fable does not
install Ollama, start its service, pull models, or use the webview for local
model egress.

Local model states are explicit: `install-required`, `start-required`,
`download-required`, `connected`, `failed`, or `unavailable`. Tool schemas are
sent only when the selected discovered model reports tool support; ordinary
prompts still run without tools.

## Settings provider UX states

Settings and onboarding use one provider-first catalogue rather than separate
subscription and API-key sections. The initial view shows a small featured set;
Show all replaces it with an alphabetical, searchable catalogue. Selecting a
provider opens its implemented connection methods (for example, a provider-owned
CLI and/or API key) in one modal. The model picker stays minimal: provider logo
plus model name.

The view avoids treating key presence as live proof: direct API, local, and
custom methods read **Configured**, while provider-owned CLI sessions can read
**Connected** after their runtime probe succeeds. Model discovery still tracks
`loading`, `success`, `empty`, `offline`, `failed`, and `unsupported` internally;
the merged picker uses live results or curated/explicit fallbacks. Settings can
refresh models, but the provider tile does not yet expose that full lifecycle.

For fixed remote API-key methods, connect outcomes distinguish a **missing** key
("No API key stored... add a key", signalled by the boundary's missing-key
message) from a **rejected** key ("key was rejected or has expired"). Transient
outcomes never mention the key, and no secret or stack trace is surfaced.

## Runs and recovery

Each run checkpoints its provider, model, active thread, transcript, usage,
pending approvals, and user/assistant/tool exchanges. On restart, in-flight
runs become `interrupted`; the chat surface offers an explicit safe retry from
the durable user prompt. Retry creates a new run with a `parentRunId`. It never
replays a prior tool result or side effect.

Terminal states are exclusive: completed, cancelled, failed, or interrupted.
Provider/parser errors cannot subsequently overwrite a run as completed.
Provider token counts are retained as reported. Dollar cost is labelled
estimated only where Fable has a maintained rate; otherwise the UI says cost is unknown.

## Tool safety

Tool calls are bounded by rounds, call count, argument size, output size, and
strict JSON shape. Unknown tools, malformed identifiers, replayed call IDs, and
oversized payloads fail before approval or execution.

Approval IDs include the current run ID and provider. Rust then requires the
exact persisted request fingerprint, tool policy, argument preview, workspace
confinement, an unconsumed permit, and a fresh execution timestamp immediately
before dispatch. Transport retries happen only before a successful response; an
interrupted stream or completed tool side effect is not replayed automatically.

## External requirements

Remote execution requires provider network access and the applicable
user-supplied credential. Ollama requires its local server to be running.
Custom requires an endpoint that implements the expected OpenAI-compatible
`/chat/completions` route; its explicit model ID removes any `/models` requirement. Tests use fixtures
and mocks; they do not validate provider account entitlements or live billing.

## Provider-specific boundaries

- OpenAI-compatible fixed profiles use provider-specific fixed HTTPS endpoints
  and bearer authentication. Anthropic uses `x-api-key` plus
  `anthropic-version: 2023-06-01`. Gemini uses `x-goog-api-key` and a validated
  model ID in the Google AI `streamGenerateContent` route.
- xAI API-key execution and Grok Build ACP execution are separate connection
  methods. Grok's provider-owned CLI login does not turn a consumer session
  into an xAI API key.
- Kimi Code membership API-key execution, Moonshot platform API-key execution,
  and Kimi ACP execution are separate methods. Mistral API-key execution and Mistral Vibe ACP execution are
  separate methods.
- No consumer Anthropic or Gemini subscription session is imported. Native
  access for those providers is API-key only.
- Meta's hosted Llama API profile is present, but availability depends on Meta
  granting the account access; Fable does not claim general availability.
- Vertex AI, Amazon Bedrock, and Azure AI/Foundry IAM are not dedicated
  integrations. Custom may work with an OpenAI-compatible endpoint that accepts
  its optional bearer-auth contract, but Custom does not provide service-account
  auth, SigV4/request signing, managed identity, or regional cloud routing.

## Limitations & Constraints

1. **No Multimodal payload / Attachments**: The native agent loop does not support uploading file or image attachments to LLM completions. The composer's file import feature works exclusively by parsing, chunking, and querying files locally via Fable's lexical retrieval engine.
2. **Curated Model Fallbacks**: If model discovery fails due to an offline, unsupported, or server error state, Fable retains its curated fallback catalog rather than falling back to an empty selection. Compatible discovered generation models need not already exist in the curated catalogue.
3. **Usage Costs**: Metrics use Fable's reviewed rate table only where one exists. Other providers show token counts with cost marked unknown instead of a fabricated zero.
4. **Mission wire families**: Durable native mission completion currently supports registered OpenAI-compatible routes, including a validated Custom endpoint. It binds the exact provider, model, route, journal head, output receipt, and provider-specific pricing evidence before accepting a result. Anthropic and Gemini mission completion remains unavailable until their distinct terminal stream contracts receive equivalent native validation and deterministic coverage.

## Failure States & Error Handling

### Connection & Read Timeouts
- **Connect Timeout**: Fable terminates connection attempts to provider endpoints after **20 seconds** to prevent indefinite hanging.
- **Read/Stream Timeout**: Once connected, Fable terminates the stream if it receives no new data chunks for **90 seconds**.
- **Credential Verify Timeout**: Credential verify checks use a connect timeout of **15 seconds** and a total request timeout of **20 seconds**.

### Retry Policy
For streaming completions, Fable will attempt up to **3 attempts** (1 initial + 2 retries) under the following conditions:
- **Retryable triggers**: Network/connection errors (`Err`), Rate-limiting HTTP status (429), or Server errors (5xx).
- **Non-retryable triggers**: Client errors (e.g. 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found) fail immediately without retrying.
- **Backoff Delay**: If a `Retry-After` header is present, Fable parses the duration in seconds and waits that long (capped at 30 seconds). Otherwise, it uses exponential backoff starting at `250 * 2^attempt` milliseconds (capped at 30 seconds).
- **Stream Interruption**: To prevent side effects, retries only occur *before* a successful response stream starts. Once streaming chunks begin, any subsequent connection drop terminates the run as `failed` and does not auto-retry.

### Cancellation
Fable provides real cancellation of active requests. When the user cancels a run or composer generation, Rust looks up the `requestId` in the `CANCEL_MAP` and signals the Tokio watch channel, dropping the reqwest response future and immediately closing the connection.

### Error Classification
Error messages generated during execution or streaming are normalized in the agent runtime into the following categories:
- **`authentication`**: Stored key is invalid, expired, or rejected (401/403). Not retryable.
- **`rate-limited`**: The provider returned HTTP 429 or quota exceeded. Retryable.
- **`cancelled`**: The run was explicitly terminated by the user. Not retryable.
- **`provider-unavailable`**: Network timeouts, connection failures, or HTTP 5xx errors. Retryable.
- **`invalid-request`**: Invalid model name, malformed payload, or size limit exceeded (e.g. body > 2MB, stream response > 16MB). Not retryable.
- **`backend-failed`**: Fallback code for unclassified errors. Not retryable.
