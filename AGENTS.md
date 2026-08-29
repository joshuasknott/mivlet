# AGENTS.md

This file applies repository-wide unless a more specific file adds local rules.

## Product contract

- Fable is an independent, provider-neutral, local-first AI teammate workspace.
- The default product is a quiet conversation with named teammates, not a
  dashboard or an orchestration console.
- Local use requires a validated model provider, not a Fable cloud account.
- Optional hosted computers and future sync must remain visibly separate from
  implemented local behavior. Never claim deployment or live integrations from
  fixtures, tests, builds, or dry-runs.
- Do not copy proprietary competitor branding, assets, code, or product copy.

## Before changing code

1. Read `README.md` and the relevant maintained architecture or ADR document.
2. Inspect the current branch, worktrees, remotes, `git status`, and the complete
   diff. Preserve unrelated user and contributor work.
3. Trace production reachability before deleting a surface. A test or document
   reference alone does not make code live.
4. Prefer a focused implementation or stabilization change over a broad new
   abstraction.

## Repository map

- `apps/desktop`: React UI, Convex functions, and the Tauri Rust boundary.
- `apps/desktop/src-tauri/resources/local-computer`: bundled Linux desktop image.
- `apps/hosted-runner`: deployment-gated Cloudflare computer/browser worker.
- `apps/broker`: confidential connector OAuth broker; never mix it with
  waitlist or product-account data.
- `apps/marketing` and `apps/waitlist`: public site and isolated signup Worker.
- `packages`: shared protocol, provider, connector, tool, voice, and knowledge
  code.

Use Node 22+, pnpm 10, and stable Rust. Do not edit generated Convex or Tauri
schema output manually.

## Implementation rules

- Keep credentials out of React state, logs, fixtures, snapshots, exports, and
  model transcripts. Use the existing native or deployment-secret boundary.
- Consequential external actions must retain exact approval and one-time-use
  checks.
- Fail closed when a provider, capability, credential, entitlement, Docker, or
  hosted dependency is missing. Explain the prerequisite in plain language.
- Preserve workspace, agent, generation, request, freshness, and control-lease
  fences.
- Use Fable protocol types across boundaries; keep vendor-specific behavior in
  adapters.
- Keep uploaded-image avatars, accessible names, keyboard behavior, focus
  management, mobile touch targets, and reduced-motion behavior intact.
- The composer uses trimmed text to choose its adaptive voice/send action.
- Fixtures must remain labelled and cannot support a live-capability claim.
- Delete confirmed dead code; do not create backup, archive, or commented-out
  graveyard copies.

## Tests and quality

Run the narrowest relevant test while editing, then the broad gates affected by
the final diff. A repository-wide pass uses:

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

When Rust changes, also run:

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

For hosted-runner changes, run:

```bash
pnpm --filter @fable/hosted-runner test
pnpm --filter @fable/hosted-runner build
```

A Wrangler dry-run validates packaging and bindings only; Docker, credentials,
deployment, and live smoke tests remain separate evidence.

Do not weaken a valuable assertion to make a suite green. Replace assertions
for retired navigation with focused coverage of current user-visible behavior.
Keep generated coverage, screenshots, audit output, build products, and local
secrets out of commits.

## Git and publication

- Do not discard unrelated dirty work or rewrite shared history.
- Fetch/prune and verify the live remote before publishing.
- Do not commit, push, deploy, create external resources, or change production
  state unless the task explicitly authorizes it.
- Never force-push for ordinary publication. If upstream moved, reconcile
  safely and rerun affected checks.
- Before handoff, run `git diff --check`, inspect the final diff, confirm no
  generated or secret files are included, and report only checks actually run.
