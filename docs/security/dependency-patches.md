# Production dependency patches

`pnpm audit:pnpm` runs regression tests, verifies the installed patched sources,
and evaluates the complete production audit report. All new findings fail the
gate. Two advisory/version pairs are accepted only when every installed copy
matches the checked source hashes in `scripts/audit/pnpm-patches.json`.
The review expires on 31 October 2026. Missing patches, different versions,
expired review, audit errors and muted reports fail closed. If an advisory
disappears, remove or revise the patch policy rather than retaining stale acceptance.

## Local patches awaiting upstream releases

Neither advisory has a published patched version as of 3 October 2026.
Registry audits inspect package versions, so raw `pnpm audit --prod` continues
to report them even after pnpm applies the local source patches.
The checked audit gate prints these findings as locally patched; it does not
claim a clean upstream dependency graph or suppress unrelated vulnerabilities.

| Dependency                   | Advisory                                                                 | Local correction                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `braces@3.0.3`               | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Bound brace and parenthesis nesting to 100 levels in the parser, and bound all three recursive AST walkers, including caller-provided ASTs. Excessive nesting raises a deliberate `SyntaxError`; ordinary patterns and escapes retain their behavior.                                                               |
| `http-cache-semantics@4.2.0` | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | Require synchronous revalidation for non-storable, no-cache, wildcard-vary, shared proxy-revalidate and shared cookie entries without the upstream public/immutable opt-in. Client max-stale and stale-while-revalidate cannot bypass these restrictions. Ordinary fresh entries and stale opt-in remain supported. |

These are runtime fixes, not assumptions that the dependency paths are unreachable.
They address the upstream reports in
[braces #70](https://github.com/micromatch/braces/issues/70) and
[http-cache-semantics #56](https://github.com/kornelski/http-cache-semantics/issues/56).
The regression tests cover the reported attacks and normal behavior. Patch hashes
prevent the audit gate from accepting an unpatched or unexpectedly modified install.

## Updating or retiring a patch

Use the pinned pnpm 10.15.0. Keep patches under `patches/` registered through
`patchedDependencies` in `pnpm-workspace.yaml`, and regenerate `pnpm-lock.yaml`.
When upstream publishes a fix, remove its patch registration and patch file,
update the dependency resolution, then remove the corresponding policy entry,
adjust the exact policy count, and retain relevant regression coverage.
Do not bump only the policy expiry or hashes to make the gate pass.

```bash
pnpm install --frozen-lockfile
pnpm audit:pnpm
pnpm check:pr
git diff --check
```

Dependency changes also require the Windows CI host and Rust checks. Full
validation remains manual or nightly. The nightly workflow can fail on unchanged
code because the upstream advisory database is live: a frozen lockfile freezes
dependency versions, not future discoveries about those versions.
