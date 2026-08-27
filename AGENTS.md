# AGENTS.md

This file applies repository-wide unless a more specific file adds local rules.

## Product contract

- Fable is an independent, vendor-neutral agent workspace.
- The default product is a quiet conversation with named agents, not a dashboard.
- The target includes selectable providers and isolated computers for bounded
  agent work. Never claim exact competitor parity or live hosted behavior without
  deployment evidence.
- Do not copy proprietary competitor branding, assets, code, or product copy.
- Keep implemented, local/foundation, deployment-gated, and missing capabilities
  visibly distinct in code, UI, tests, and documentation.

## Before changing code

1. Read `README.md` and any relevant current architecture or ADR document.
2. Inspect `git status`, the current branch/worktree, remotes, and the complete
   diff. Preserve existing user and contributor work.
3. Trace production reachability before deleting a surface. Tests or documents
   alone do not make a component live.
4. Prefer a focused stabilization or implementation change over a new broad
   abstraction or redesign.

## Repository map

- `apps/desktop`: React UI, Convex functions, and the Tauri Rust boundary.
- `apps/hosted-runner`: deployment-gated Cloudflare computer/browser/routine worker.
- `apps/broker`: confidential OAuth broker; never mix it with waitlist data.
- `apps/marketing` and `apps/waitlist`: public site and isolated signup Worker.
- `packages`: shared protocol, provider/connector/tool, voice, and knowledge code.

## Implementation rules

- Keep credentials out of React state, logs, fixtures, snapshots, exports, and
  model transcripts. Use the existing native or deployment-secret boundary.
- Consequential external actions must retain exact approval checks.
- Fail closed when a provider, capability, credential, entitlement, or hosted
  dependency is missing. Explain the missing prerequisite in plain language.
- Preserve all scope, generation, request, and one-time-use fences.
- Use Fable protocol types across boundaries; keep vendor-specific behavior in
  adapters.
- Keep uploaded-image avatars, accessible names, keyboard behavior, focus
  management, mobile touch targets, and reduced-motion behavior intact.
- The composer uses trimmed text to choose its adaptive voice/send action.
- Fixtures must be labeled and must never support a live-capability claim.

## Tests and quality

Run the narrowest relevant test while editing, then the broad gates affected by
the final diff. For a repository-wide stabilization or publication pass, use:

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

Run hosted-runner tests/builds for hosted changes. A Wrangler dry-run validates
packaging and bindings only; record Docker, credentials, deployment, and live
smoke tests separately.

Do not weaken a valuable assertion just to make a suite green. Replace retired
navigation assertions with focused coverage of current user-visible behavior.
Keep generated coverage, screenshots, audit output, build products, and local
secrets out of commits.

## Documentation and cleanup

- Current code and fresh runtime evidence outrank stale plans or screenshots.
- Keep root documentation concise and truthful; prefer one maintained source to
  status snapshots, archives, duplicated plans, or audit dumps.
- Delete confirmed dead code and obsolete artifacts outright. Do not create
  `_old`, backup, archive, or commented-out graveyard copies.
- Update or remove references when deleting a document or route.

## Git and publication

- Do not discard unrelated dirty work or rewrite shared history.
- Fetch/prune and verify the live remote before publishing.
- Do not commit, push, deploy, create external resources, or change production
  state unless the task explicitly authorizes that action.
- Never force-push for routine publication. If upstream moved, reconcile safely
  and rerun affected checks.
- Before handoff, run `git diff --check`, inspect the staged diff, confirm no
  generated or secret files are included, and report only checks actually run.
