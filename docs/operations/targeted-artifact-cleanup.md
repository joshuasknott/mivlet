# Safe targeted build-artifact cleanup

Use this only to recover space or force a clean local rebuild. It removes
generated build output, never Fable user data.

## Before cleanup

1. Stop `pnpm dev`, `pnpm tauri:dev`, tests, and packaging processes.
2. Confirm the repository root and inspect `git status`.
3. Preserve any generated artifact currently being used as evidence.
4. Do not clean while another worktree or task is building into the same target.

## Safe targets

Remove only a target that exists under the confirmed repository root:

- `apps/desktop/dist`
- `apps/marketing/dist`
- `apps/broker/dist`
- `apps/waitlist/dist`
- `packages/protocol/dist`
- `packages/connectors/dist`
- `packages/knowledge/dist`
- package `tsconfig.tsbuildinfo` files when forcing TypeScript regeneration
- `apps/desktop/src-tauri/target/debug` for native development output
- `apps/desktop/src-tauri/target/release` only after intentionally discarding
  local packaging output

Keep `node_modules` unless dependency installation itself is being repaired.
Prefer `pnpm install --frozen-lockfile` over deleting the dependency store.

## Never remove

- `.git`, source files, migrations, fixtures, or checked documentation
- `.env.local` or any ignored local configuration
- `fable-vault.db`, recovery backups, staged restores, portable exports, or any
  directory under the operating-system Fable app-data location
- installer output that is the only copy of validation evidence
- a broad workspace, home, drive, temp, or wildcard-derived path

## Rebuild and verify

After a JavaScript-only cleanup, run `pnpm verify:build` and
`pnpm perf:check`. After native target cleanup, run the Rust format, strict
Clippy, and test gates before relying on the rebuilt binaries. A cleanup is not
evidence that the product still works; the corresponding checks must pass.
