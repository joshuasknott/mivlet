# Local Model Runtime

Batch 2C adds Fable's first production-honest local model integration. The
runtime is deliberately narrow: Fable can detect and use an externally managed
Ollama service on a literal loopback address, but it does not bundle a model,
download a model, start a runtime, or fall back to a cloud provider.

## Trust Boundary

Local model access is a trusted loopback integration, not general web-fetch
permission. The desktop boundary accepts only `http` URLs whose host is a
literal loopback IP address such as `127.0.0.1` or `::1`. Hostnames, credentials,
queries, fragments, non-loopback addresses, and `https` endpoints are rejected.

The default endpoint is `http://127.0.0.1:11434`. Developers may override it
with `FABLE_OLLAMA_BASE_URL`, but the same literal-loopback validation still
applies.

Fable never logs prompt or response payloads for local model calls. Action
history records only provider, model, request correlation id, and terminal
status.

## Runtime States

The local provider reports the same provider-neutral backend contract as other
agent runtimes. For Ollama, discovery maps into these states:

- `install-required`: no reachable service and the `ollama` CLI is not detected.
- `start-required`: the CLI is detected, but the loopback service is offline.
- `download-required`: Ollama is running, but no usable local generation model
  is installed.
- `connected`: Ollama is running and at least one installed generation model was
  discovered.
- `failed` or `unavailable`: endpoint validation or protocol probing failed.

Fable does not run `ollama pull`, does not start the service, and does not
change model state. Settings and onboarding surface those states truthfully.

## Protocol Surface

The integration probes:

- `GET /api/version` for runtime availability and version.
- `GET /api/tags` for installed local models.
- `POST /api/show` for per-model capabilities.
- `POST /api/chat` for streaming generation.

Streaming is newline-delimited JSON. Fable forwards the stream through the
existing provider-neutral `AgentBackend` event contract and preserves cooperative
cancellation by aborting the in-flight loopback request at the Rust boundary.

Requests are capped at 2 MiB. Discovery responses are capped at 4 MiB. Streaming
responses are capped at 16 MiB. Oversized payloads fail closed.

## Capability Negotiation

Local loopback providers start with only local runtime capabilities:

- streaming
- model availability
- cancellation

Tool-use, approvals, and file-change capabilities are added only when an
installed model reports tool support through `/api/show`. If a local model does
not report tool support, Fable does not advertise tool schemas to the model.
If tools are supported, tool calls still route through Fable's approval and
permission policy before any tool executes.

## Smoke Test

Ordinary tests do not require a live Ollama install. The real-runtime smoke test
is opt-in:

```powershell
$env:FABLE_RUN_OLLAMA_SMOKE="1"
$env:FABLE_OLLAMA_BASE_URL="http://127.0.0.1:11434"
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml real_ollama_smoke_is_opt_in
```

Before running it, install Ollama, start its local service, and install at least
one generation model through Ollama itself, for example:

```powershell
ollama pull llama3.2
```

Fable will verify that the service is reachable and that at least one generation
model is installed. The smoke test does not download models.

## Future llama.cpp Runtime

A future bundled llama.cpp runtime should plug into the same provider-neutral
`AgentBackend` contract and should keep the local-runtime boundary separate from
general web egress. That future work must explicitly solve model packaging,
GPU/runtime redistribution, platform notarization, update size, model license
display, and opt-in download flows before any model or inference runtime is
bundled with Fable.

Batch 2C intentionally ships none of those bundled assets. Ollama's MIT-licensed
client/server and each model's own license remain external to Fable in this
integration; users manage those installations and licenses outside the app.
