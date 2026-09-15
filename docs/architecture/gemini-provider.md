# Direct Gemini provider

Date: 2026-09-15

Status: Implemented locally. This is not an embedded-host route.

## Decision

Direct Gemini text and tool turns use Mivlet's local wire loop
(`shapeGeminiRequest` / `parseGeminiLine`) over the same Rust egress boundary as
other API-key providers. They do **not** use `packages/agent-host` / OpenCode V2.
The Gemini SDK admission contract is not verified; Mivlet does not wrap a second
agent loop around the first.

Operators should not treat catalogue presence, the embedded host pin
(`0.0.0-dev-19449`), or OpenAI-compatible fixture tests as evidence that Gemini
runs on that host.

## Credential and discovery

The API key stays in the account-scoped OS secure store and never crosses into
JavaScript, logs, or transcripts. Discovery uses the official `models.list`
endpoint. Credential verification hit-tests the stored key the same way as other
direct routes.

## Vision

Native screenshots are unavailable on this route. Vision metadata alone never
enables a screenshot bridge. See the
[native computer matrix](local-teammate-computer.md#tool-and-provider-paths).

## Related

- [Provider driver registry](../adr/2026-09-03-provider-driver-registry.md)
- [OpenRouter provider](openrouter-provider.md) (embedded-host contrast)
