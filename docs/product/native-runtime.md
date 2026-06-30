# Native Agent Runtime

Fable's native API path supports OpenAI-compatible, Anthropic, and Gemini wire formats while keeping provider credentials inside the Rust boundary.

## Setup and Credentials

All native providers are **Bring Your Own Key (BYOK)**. The desktop runtime manages credentials through a keyring-backed secure storage boundary on the user's OS, with an in-memory fallback for headless or test environments.
- **Key Storage**: Raw API keys never cross the Rust-to-JavaScript boundary and are never exposed to the frontend React application.
- **Header Injection**: The credentials are looked up inside Rust immediately prior to HTTP egress and are injected directly into the provider-specific HTTP headers.
- **Validation**: Stored keys are validated by hit-testing the provider's model list endpoint. 

## Implemented Provider Capability Matrix

The following matrix documents the exact features implemented in the codebase for each native provider.

| Feature / Capability | OpenAI | Anthropic | Gemini | xAI | OpenRouter | Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Chat / Completion** | Yes | Yes | Yes | Yes | Yes | The agent loop is hosted and owned by Fable. |
| **Streaming** | Yes | Yes | Yes | Yes | Yes | Enabled via Server-Sent Events (SSE) or JSON-per-line. |
| **Model Listing / Discovery** | Yes | Yes | Yes | Yes | Yes | Dynamic query of provider models. Bounded to 1,000 models, 4MB, 10 pages. |
| **Tool / Function Support** | Yes | Yes | Yes | Yes | Yes | Maps Fable tools into provider formats. Approval-gated execution. |
| **Attachments / Files** | **No** | **No** | **No** | **No** | **No** | Input format is text/tools only. Multi-modal payloads are not supported. |
| **Connect Timeout** | 20s | 20s | 20s | 20s | 20s | Hard timeout for establishing a connection to the API. |
| **Read / Stream Timeout** | 90s | 90s | 90s | 90s | 90s | Hard timeout for waiting for stream chunks / response data. |
| **Retries & Backoff** | Yes | Yes | Yes | Yes | Yes | Up to 3 attempts. Retries only rate limits (429) & server errors (5xx). |
| **Cancellation** | Yes | Yes | Yes | Yes | Yes | Active HTTP request is dropped immediately when cancelled. |
| **Credential Validation** | Yes | Yes | Yes | Yes | Yes | Bounded list-models GET request (15s connect, 20s total timeout). |

## Settings provider UX states

The Settings -> Providers view reflects real runtime state instead of optimistic
copy. Each connected API-key provider row carries a per-provider model-discovery
lifecycle layered on top of its auth state:

- `loading` - a spinner; the Refresh/Retry control is disabled mid-flight.
- `success` - the connected badge reads "Connected"; models are shown.
- `empty` - the account surfaced no usable models; the hint points at the plan
  or billing, never at the key.
- `offline` / `failed` - "connected but degraded": the key is fine, the model
  list just could not be confirmed. Recoverable via the per-row Refresh action,
  which re-runs discovery without reconnecting.
- `unsupported` - the provider exposes no model list; the user picks manually.

Connect outcomes distinguish a **missing** key ("No API key stored... add a key",
signalled by the boundary's missing-key message) from a **rejected** key ("key
was rejected or has expired"). Transient outcomes never mention the key, and no
secret or stack trace is surfaced.

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
before dispatch. Transport retries happen only before a successful response; an
interrupted stream or completed tool side effect is not replayed automatically.

## External requirements

Live execution requires a user-supplied API key in OS secure storage and
provider network access. Tests use fixtures and mocks; they do not validate
provider account entitlements or live billing.

## Provider Details

### OpenAI
- **Endpoint**: `https://api.openai.com/v1/chat/completions` (Completion) and `https://api.openai.com/v1/models` (Discovery).
- **Credentials**: Stored under the service identifier `openai` as a Bearer token: `Authorization: Bearer <key>`.
- **Wire Format**: Chat Completions JSON. Uses `max_completion_tokens` for reasoning models (`o1`/`gpt-5`) and `max_tokens` for other models.
- **Model Listing**: Filters out non-generation models (e.g. `embedding`, `moderation`, `whisper`, `tts-`, `dall-e`, `image`, `realtime`, `audio`).

### Anthropic
- **Endpoint**: `https://api.anthropic.com/v1/messages` (Completion) and `https://api.anthropic.com/v1/models` (Discovery).
- **Credentials**: Stored under the service identifier `anthropic` as `x-api-key: <key>`.
- **Headers**: Injects the required `anthropic-version: 2023-06-01` header on all requests.
- **Streaming Parser**: Stateful SSE parser. Streams tool input as incremental `input_json_delta` fragments which are buffered by block index and parsed when the content block closes.
- **Tool Mapping**: Transforms Fable tool schemas to `tools` blocks using `input_schema` properties. Delivers results as content blocks with `tool_result` type.
- **Limitations**: Vertex AI and Amazon Bedrock routing are reserved as future extensions; direct API-key egress is the only implemented path.

### Gemini
- **Endpoint**: Google AI API endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse` (Completion) and `https://generativelanguage.googleapis.com/v1beta/models` (Discovery).
- **Credentials**: Stored under the service identifier `gemini` as `x-goog-api-key: <key>`.
- **Wire Format**: Gemini generateContent format. Streams JSON-per-line (not SSE `data:` frames).
- **Tool Mapping**: Transforms tool schemas into a single element array of `tools` containing `functionDeclarations`. Parses candidate parts containing `functionCall`.
- **Limitations**:
  - Model ID contains strict character checks in Rust: must be alphanumeric and may only contain `-._` characters.
  - Vertex regional endpoint routing is cataloged but not active. Direct Google AI API-key egress is the only active path.
  - No support for Google AI Pro/Ultra subscriber session reuse (terms forbid third-party OAuth access).

### xAI
- **Endpoint**: `https://api.x.ai/v1/chat/completions` (Completion) and `https://api.x.ai/v1/models` (Discovery).
- **Credentials**: Stored under the service identifier `xai` as `Authorization: Bearer <key>`.
- **Wire Format**: OpenAI-compatible Chat Completions.
- **Entitlements**: Grok Build entitlements are never promised or assumed in preview/fixture data; they are resolved post-login only.

### OpenRouter
- **Endpoint**: `https://openrouter.ai/api/v1/chat/completions` (Completion) and `https://openrouter.ai/api/v1/models` (Discovery).
- **Credentials**: Stored under the service identifier `openrouter` as `Authorization: Bearer <key>`.
- **Wire Format**: OpenAI-compatible Chat Completions.

## Limitations & Constraints

1. **No Multimodal payload / Attachments**: The native agent loop does not support uploading file or image attachments to LLM completions. The composer's file import feature works exclusively by parsing, chunking, and querying files locally via Fable's lexical retrieval engine.
2. **Curated Model Fallbacks**: If model discovery fails due to an offline, unsupported, or server error state, Fable retains its curated fallback catalog rather than falling back to an empty selection.
3. **Usage Costs**: Metrics for `usage-cost` are calculated on-the-fly against Fable's internal price table since native API keys are metered directly at the provider side.

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
