# Fable

Fable is an independent, vendor-neutral agent workspace for real work. Its
primary experience is a quiet desktop conversation with named agents; providers,
knowledge, connections, approvals, routines, and execution details appear when
they are useful rather than defining the navigation.

The long-term direction is Grok-Bot-class capability: selectable model providers
and isolated computers that let agents continue bounded work. Fable does not
claim exact parity, and this repository contains no proprietary Grok branding,
assets, or code.

## Maturity

Fable is pre-release software. The repository contains a substantial local
desktop product and a hosted-execution foundation, but it is not a deployed,
production-validated service.

### Implemented in the repository

- Tauri 2 desktop app with a React and TypeScript agent-first shell.
- Named agent profiles, conversations, model selection, learning records, team
  missions, live-work visibility, and a single adaptive voice/send composer.
- Native provider adapters for OpenAI-compatible, Anthropic, and Gemini wire
  formats, plus supported local CLI/ACP runtimes and external Ollama.
- Encrypted SQLite persistence for local workspace state, knowledge, memory,
  approvals, schedules, run history, artifacts, and provenance.
- Approval-gated native tools and connector actions with one-time, session,
  rule, modify, and deny decisions.
- Local knowledge ingestion/retrieval, connector boundaries, projects, missions,
  and schedules.
- Runtime-detected browser/operating-system dictation. It fails closed when the
  host webview has no speech-recognition API; Fable does not retain raw audio or
  a separate transcript.
- A Cloudflare hosted-runner foundation using Sandbox/Containers, Durable
  Objects, Browser Run, and Workers AI, with protocol, desktop, Convex, and Rust
  authority boundaries for hosted computers, browser actions, recurring agent
  routines, and exact-program schedules.

### Deployment-gated or externally configured

- Hosted computers and routines require deployed Cloudflare resources, a
  configured Clerk/Convex environment, secrets, container availability, and
  live smoke testing.
- Remote model providers require the user's valid credentials and entitlements;
  CLI providers require their own installed and authenticated tools.
- Google connectors require a public desktop OAuth client. Confidential OAuth
  connectors require the separate broker to be configured and deployed.
- Clerk identity and Convex collaboration paths exist, but production tenancy,
  recovery, metering, and multi-device behavior are not validated here.

### Not complete

- Dependable always-on production operation, monitoring, quotas, upgrades, and
  disaster recovery.
- Secure third-party sign-in/secret handoff inside hosted agent computers.
- Automatic background continuation of ordinary local chats.
- Mobile remote control, signed installers, updater channels, and supported
  macOS/Linux releases.

See [hosted teammate computer](docs/architecture/hosted-teammate-computer.md)
for the hosted trust boundary and remaining deployment work.

## Repository layout

```text
apps/desktop        Tauri desktop app, native Rust boundary, and Convex functions
apps/hosted-runner  Cloudflare hosted computer and routine worker
apps/broker         confidential OAuth broker
apps/marketing      Astro marketing site
apps/waitlist       isolated waitlist Worker
packages/protocol   shared product and authority contracts
packages/connectors provider, tool, connector, and voice adapters
packages/knowledge  ingestion and retrieval engine
docs                current architecture, ADRs, security, and operations notes
```

## Requirements

- Node.js 22 or newer
- pnpm 10 (the repository pins `pnpm@10.15.0`)
- Rust stable and platform Tauri prerequisites for native checks/builds
- Windows WebView2 for the current desktop preview target

Docker and Cloudflare credentials are needed only for container-backed local or
deployment validation. They are not required for the ordinary TypeScript test
suite.

## Setup and development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the desktop Vite surface. To run it through Tauri:

```bash
pnpm tauri:dev
```

Configuration templates live beside the app that owns them:

- `apps/desktop/.env.example`
- `apps/broker/.env.example`
- `apps/broker/.dev.vars.example`
- `apps/hosted-runner/.dev.vars.example`

Copy only the template you need and keep real credentials out of Git. Missing
external configuration should leave the corresponding feature unavailable,
not silently substitute fixtures.

## Verification

Fast, useful gates:

```bash
pnpm typecheck
pnpm test
pnpm quality
pnpm verify:build
pnpm tauri:check
```

`pnpm check` runs the broad repository gate, adding performance, native runtime,
release-manifest, and dependency-audit checks. Audits use current registries and
therefore require network access.

Hosted-runner checks can also be run directly:

```bash
pnpm --filter @fable/hosted-runner test
pnpm --filter @fable/hosted-runner build
pnpm --filter @fable/hosted-runner exec wrangler deploy --config wrangler.jsonc --dry-run --containers-rollout=none
```

The last command packages and validates bindings without deploying. It does not
prove a live Container, Browser Run, Durable Object, Workers AI, Clerk, or Convex
environment.

Native formatting and tests:

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Working principles

- Keep the default UI sparse, conversational, accessible, and agent-first.
- Preserve provider choice and Fable-owned contracts; isolate vendor adapters.
- Keep credentials behind native or deployment-secret boundaries.
- Bind consequential actions to explicit approvals and fail closed when
  authority or configuration is missing.
- Treat tests, fixtures, dry-runs, and local builds as evidence of foundation
  work—not evidence of deployment, live integrations, or product parity.

Contributor-specific guidance is in [AGENTS.md](AGENTS.md). Product direction is
summarized in [docs/product/vision.md](docs/product/vision.md).
