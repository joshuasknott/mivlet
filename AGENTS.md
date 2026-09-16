# Mivlet

Independent, provider-neutral, local-first AI agent workspace. Preserve the quiet conversation with named agents and keep account identity, workspace data, and provider credentials separate. Signed-out users authenticate; signed-in users open their local workspace without onboarding. Agent execution requires a validated provider. Keep hosted and planned features distinct from implemented local behavior.

## Map and context

- apps/desktop: React, Convex, and the Tauri/Rust boundary; src-tauri/resources/cua-driver contains the pinned Windows runtime and redistribution notices.
- apps/hosted-runner: deployment-gated Cloudflare computer/browser worker.
- apps/broker: confidential connector OAuth broker, separate from account data.
- packages: shared protocol, providers, connectors, tools, voice, and knowledge.

Read README.md and the architecture or ADR relevant to the change. Use Node 22+, pnpm 10, and stable Rust. Inspect the current diff before editing; trace production reachability before deleting a surface. Preserve unrelated work and do not hand-edit generated Convex or Tauri schemas.

## Invariants

- Keep secrets behind native or deployment-secret boundaries, out of React state, logs, model transcripts, fixtures, and exports.
- Preserve exact single-use approvals, workspace/agent/request/generation/freshness fences, and computer control leases.
- Missing providers, credentials, entitlements, the bundled Windows runtime, or hosted dependencies must fail closed with a clear prerequisite.
- Native computer use shares the user's Windows session and follows global approvals. Full Access adds no app grants; agents select an exact window and delivery mode through approved tools. Background actions must never silently escalate to foreground. Preserve immediate Stop, exact target identity, turn generations and single-agent control. Never add a host-shell fallback.
- Use shared protocol types and provider adapters; keep vendor behavior inside drivers/adapters.
- Preserve image avatars, accessible controls, keyboard/focus behavior, touch targets, reduced motion, and the trimmed-text voice/send composer action.
- Fixtures and dry-runs do not establish live capability. Do not copy proprietary branding, assets, code, or product copy.
- Remove confirmed dead code without archive or commented-out copies.

## Verification and publication

Run the narrowest relevant test while editing, then the gates affected by the final diff. See [the verification guide](docs/development/verification.md) for package, Rust, performance, and release commands. Do not weaken useful assertions to pass a suite.

Ordinary PRs use TypeScript checks and conditional Windows validation. Run focused
local checks while editing; reserve `pnpm check` for release/integration readiness
and manual or scheduled full validation. Flag pull requests that net +200 lines
in a file already over 800 lines unless the change is an extraction; do not
hard-fail CI on line counts. Batch coherent changes before pushing.

Before handoff inspect the final diff and run `git diff --check`. Keep generated artifacts and secrets out of commits. Publication requires task authorization: verify the remote, reconcile upstream safely, and rerun affected checks. Do not force-push or discard unrelated work.
