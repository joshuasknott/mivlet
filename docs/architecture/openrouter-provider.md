# OpenRouter provider

Date: 2026-09-11

Status: Implemented

## Connection

OpenRouter connects as an explicit API-key provider through the existing native
driver registry: one OpenRouter API key, stored by Mivlet's local credential
boundary (`com.fable.workspace` OS secure store, account-scoped). The provider
uses the `native-api` driver kind, the `api-key` setup surface, and the bundled
OpenCode embedded host for text and tool turns — the same production path as
direct OpenAI, Anthropic, xAI, and custom OpenAI-compatible connections.

- Chat endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Model list endpoint: `https://openrouter.ai/api/v1/models`
- Auth: `Authorization: Bearer <key>`, added by the Rust boundary; the key
  never crosses into JavaScript, logs, transcripts, or the renderer.

OpenRouter is an OpenAI-compatible API
([Quickstart](https://openrouter.ai/docs),
[Streaming](https://openrouter.ai/docs/api_reference/streaming),
[Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion),
[List all models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)),
so Mivlet reuses the audited OpenAI-compatible request shaping and SSE parsing.
Optional app-attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`,
[App Attribution](https://openrouter.ai/docs/app-attribution)) are deliberately
not sent: Mivlet does not identify the app to OpenRouter, and no identifying
headers are stored or transmitted.

## Model discovery and capabilities

`GET /api/v1/models` returns the full catalog; Mivlet paginates with the
documented `offset`/`limit` parameters and bounds the result (1,000 models,
10 pages). The response is filtered to chat-completions routes:

- `~` "latest alias" rows (rows with an `alias_target`) are excluded — they
  resolve to a different model over time and have no stable identity
  ([Latest Model Resolution](https://openrouter.ai/docs/guides/routing/routers/latest-resolution)).
- Rows whose `output_modalities` do not include `text` (image generation,
  embeddings, TTS) are excluded — they have no chat-completions route.
- Non-generation marker ids (embedding, moderation, TTS, image, audio, realtime)
  are excluded by the existing generation-model filter.

Per-model capabilities are derived only from the model's own metadata
([models schema](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)):

| Mivlet capability | Source |
| --- | --- |
| `contextWindow` | `context_length` (bounded to the embedded host budget) |
| `streaming` | the chat-completions route always streams (`stream: true`) |
| `tools` | `supported_parameters` lists both `tools` and `tool_choice` |
| `structuredOutput` | `supported_parameters` lists `structured_outputs` |
| `reasoning` | the `reasoning` object is present and `reasoning_effort` is a supported parameter; levels come from `reasoning.supported_efforts` (restricted to the documented effort vocabulary) with `default_effort` when listed |
| `vision` | never advertised: OpenRouter metadata lists `image` input for many models, but Mivlet's OpenRouter route has no verified image-egress protocol. Native screenshots and image turns fail closed on this route (see the [native computer matrix](local-teammate-computer.md#tool-and-provider-paths)) |

Unknown metadata produces no capability field. A model with an empty or `null`
effort allowlist ("all gateway effort values accepted") does not advertise
reasoning levels, because Mivlet would otherwise reject valid levels it does
not know. Capabilities always reflect the selected model id and the supported
route; a newly discovered model is never marked tool/vision/reasoning capable
by inheritance.

## Routing and privacy

Mivlet sends the selected model id verbatim and adds no application-level
fallback: there is no second model, no silent provider switch, and no redirect
to another configured account. A turn uses exactly the model the user picked,
and a failed turn surfaces a truthful error.

OpenRouter itself performs downstream routing for that id
([Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)):

- The model id encodes the hosting provider (`openai/gpt-4.1`, `anthropic/...`).
- `:free`, `:floor`, `:extended`, `:thinking`, `:nitro`, and `:online` variants
  select OpenRouter's own pricing/quality routing
  ([Free](https://openrouter.ai/docs/guides/routing/model-variants/free),
  [Floor](https://openrouter.ai/docs/guides/routing/model-variants/floor),
  [Extended](https://openrouter.ai/docs/guides/routing/model-variants/extended),
  [Thinking](https://openrouter.ai/docs/guides/routing/model-variants/thinking),
  [Nitro](https://openrouter.ai/docs/guides/routing/model-variants/nitro),
  [Online](https://openrouter.ai/docs/guides/routing/model-variants/online)).
- `openrouter/auto` selects the [Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router),
  which picks a model per prompt from the community's market.
- Fallbacks and provider ordering are OpenRouter-side behavior; Mivlet neither
  enables nor overrides them, and it never silently retries a turn on another
  provider after an OpenRouter failure (the existing retry policy only re-sends
  the identical request to the identical endpoint on transient network/HTTP
  errors, never to a different model or account).
- Account-level privacy and logging settings are configured on the OpenRouter
  dashboard and apply to requests as OpenRouter documents them
  ([Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection),
  [Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging),
  [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)).

Because the request body is carried verbatim between Mivlet's shaper and the
OpenRouter endpoint, any routing/privacy fields a future Mivlet integration
adds to the body would reach OpenRouter unchanged.

### Implemented routing settings

- Explicit model-id routing, including `:free`/`:floor`/`:extended` variants
  and `openrouter/auto`, surfaced through model discovery and preserved
  verbatim on egress.
- No identifying headers; no silent fallback; exact one-model-per-turn
  selection; truthful failure states.

### Deferred routing settings

- A Mivlet UI for OpenRouter's `provider` routing object (`order`, `allow`,
  `ignore`), `route`/service-tier selection
  ([Service Tiers](https://openrouter.ai/docs/guides/features/service-tiers)),
  in-region routing
  ([In-Region Routing](https://openrouter.ai/docs/guides/features/in-region-routing)),
  and Zero Data Retention selection is not implemented; the model id remains
  the only routing control.
- Image/vision delivery and native screenshots on OpenRouter models are
  deferred pending route-specific verification; vision metadata is parsed but
  never advertised.
- OpenRouter-specific price accounting (`pricing` fields in the model list)
  is not wired into usage cost: Mivlet reports OpenRouter usage with
  `costUnknown: true` until exact source-attributed pricing exists.

## Sources

- Quickstart: https://openrouter.ai/docs
- Streaming: https://openrouter.ai/docs/api_reference/streaming
- Chat Completions: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
- List all models: https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
- Provider routing: https://openrouter.ai/docs/guides/routing/provider-selection
- Model fallbacks: https://openrouter.ai/docs/guides/routing/model-fallbacks
- Auto Router: https://openrouter.ai/docs/guides/routing/routers/auto-router
- Latest resolution (aliases): https://openrouter.ai/docs/guides/routing/routers/latest-resolution
- Free/Floor/Extended variants: https://openrouter.ai/docs/guides/routing/model-variants/free,
  https://openrouter.ai/docs/guides/routing/model-variants/floor,
  https://openrouter.ai/docs/guides/routing/model-variants/extended
- Privacy and data: https://openrouter.ai/docs/guides/privacy/data-collection,
  https://openrouter.ai/docs/guides/privacy/provider-logging
- App attribution (not sent): https://openrouter.ai/docs/app-attribution