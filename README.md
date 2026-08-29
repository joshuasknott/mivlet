# Fable

Fable is an independent, provider-neutral AI teammate workspace. Its default
experience is a quiet desktop conversation with named teammates. Connections,
knowledge, approvals, and a teammate's computer appear only when the work needs
them.

Fable is local-first: the usable product does not require a Fable cloud account.
A person connects a supported model provider, creates a teammate, and can then
work with local encrypted data and an isolated local computer.

## Maturity

Fable is pre-release Windows desktop software. This repository contains a
substantial local product and an optional hosted-computer foundation; it is not
a deployed or production-validated service.

### Implemented locally

- A Tauri 2 desktop app with a compact React conversation shell, named teammate
  profiles, image avatars, model selection, and one adaptive voice/send
  composer.
- First-run setup that prepares local storage, validates at least one supported
  provider connection, and creates the first teammate before entering chat.
- Provider adapters for OpenAI-compatible, Anthropic, and Gemini wire formats.
  Codex uses its official ChatGPT browser sign-in; OpenAI, Anthropic, Gemini,
  xAI, and custom OpenAI-compatible connections use explicit API credentials.
- Encrypted SQLite persistence for conversations, knowledge, memory,
  connections, approvals, audit history, and a minimal internal execution
  attempt used for safe interruption and retry.
- Provider and plugin-style Connections, including connector and MCP
  boundaries. Credentials stay in native or service-secret custody rather than
  React state or conversation transcripts.
- Exact approval checks for consequential tools and connector actions.
- A genuine separate Linux desktop per workspace/teammate, backed by Docker
  Desktop's WSL 2 engine. It has a persistent home volume, Chromium, a file
  manager, a terminal, a small scoped workspace bridge, resource limits, and a
  five-minute watch/take-control lease. Local terminal commands execute only
  inside that container; Fable never falls back to the host shell.
- Runtime-detected operating-system dictation. It fails closed when speech
  recognition is unavailable and does not retain raw audio.

### Optional and deployment-gated

- The hosted runner contains bounded Cloudflare computer and browser endpoints
  with short-lived generation-fenced capabilities. Local tests and packaging
  checks do not prove that Containers, Browser Rendering, Durable Objects,
  Convex, Clerk, or production secrets have been deployed.
- Account and sync code is optional foundation for future shared or multi-device
  work. It does not gate local setup and is not a current production
  collaboration claim.
- Confidential connector OAuth needs the separate broker and provider
  configuration. Direct provider APIs and Codex browser sign-in still require
  valid credentials, entitlement, installed components, and network access.

### Not complete

- Automatic continuation of ordinary conversations after the desktop app
  closes.
- Secure sign-in or secret handoff inside a hosted teammate computer.
- Deployed hosted operation, live third-party validation, production tenancy,
  metering, quotas, monitoring, disaster recovery, or multi-device sync.
- Signed public installers, updater channels, supported macOS/Linux releases,
  and mobile control.

The [local computer](docs/architecture/local-teammate-computer.md) and
[hosted computer](docs/architecture/hosted-teammate-computer.md) documents define
their separate trust boundaries.

## Repository layout

```text
apps/desktop        React UI, Convex functions, and the Tauri Rust boundary
apps/hosted-runner  deployment-gated Cloudflare computer/browser worker
apps/broker         narrow confidential connector OAuth broker
apps/marketing      Astro marketing site
apps/waitlist       isolated waitlist Worker
packages/protocol   shared product and authority contracts
packages/connectors provider, connector, tool, voice, and MCP adapters
packages/knowledge  local ingestion and retrieval engine
docs                maintained architecture, security, and operations notes
```

## Requirements

- Node.js 22 or newer
- pnpm 10 (the repository pins `pnpm@10.15.0`)
- Stable Rust and the Windows Tauri prerequisites
- Windows WebView2
- Docker Desktop using its WSL 2 Linux engine for the isolated local computer
- Official Codex app-server components for optional ChatGPT browser sign-in

Docker is not required for the browser-only preview or ordinary TypeScript
tests. The first local-computer setup builds its bundled image and therefore
needs Docker running plus network access for the image packages.

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the browser-only Vite preview, whose synthetic state is
labelled. Use the native app for provider credentials, encrypted persistence,
and the isolated teammate computer:

```bash
pnpm tauri:dev
```

Configuration templates live beside the component that owns them:

- `apps/desktop/.env.example`
- `apps/broker/.env.example`
- `apps/broker/.dev.vars.example`
- `apps/hosted-runner/.dev.vars.example`

Keep real credentials out of Git. Missing optional configuration must leave the
related capability unavailable rather than substituting a fixture.

## Verification

The broad repository gates are:

```bash
pnpm typecheck
pnpm test
pnpm quality
pnpm verify:build
pnpm perf:check
pnpm perf:test
pnpm release:test
pnpm tauri:check
```

For Rust changes, also run:

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Hosted-runner changes require its focused tests, build, and a Wrangler dry-run.
A dry-run validates packaging and bindings only; it does not validate a live
Cloudflare environment.

## Working principles

- Keep the default UI sparse, conversational, accessible, and teammate-first.
- Preserve provider choice behind Fable-owned contracts and adapters.
- Keep credentials behind native or deployment-secret boundaries.
- Bind consequential actions to exact approvals and fail closed when authority
  or configuration is missing.
- Treat fixtures, tests, dry-runs, and local builds as local evidence, never as
  deployment, integration, or product-parity evidence.

Contributor guidance is in [AGENTS.md](AGENTS.md). Product direction is in
[docs/product/vision.md](docs/product/vision.md).
