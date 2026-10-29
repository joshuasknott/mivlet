# Production dependency patches

`pnpm audit:pnpm` runs regression tests, verifies the installed patched sources,
and evaluates the complete production audit report. Every reported advisory fails
the gate. Both retained local patches are source-verified against
`scripts/audit/pnpm-patches.json` and grant no registry advisory exemptions.
The review expires on 31 October 2026. Missing patches, different versions,
expired review, audit errors and muted reports fail closed. If an advisory
disappears, remove or revise the patch policy rather than retaining stale acceptance.

## Retained local hardening

GitHub withdrew the braces advisory on 23 October 2026 and the cache advisory on
28 October 2026. Their policy entries retain the existing hardening, regression
tests and source hashes, with `advisory: null`. If either advisory reappears,
the gate rejects it for review rather than automatically exempting it.

| Dependency                   | Advisory                                                                 | Local correction                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `braces@3.0.3`               | [Withdrawn GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Bound brace and parenthesis nesting to 100 levels in the parser, and bound all three recursive AST walkers, including caller-provided ASTs. Excessive nesting raises a deliberate `SyntaxError`; ordinary patterns and escapes retain their behavior.                                                               |
| `http-cache-semantics@4.2.0` | [Withdrawn GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | Require synchronous revalidation for non-storable, no-cache, wildcard-vary, shared proxy-revalidate and shared cookie entries without the upstream public/immutable opt-in. Client max-stale and stale-while-revalidate cannot bypass these restrictions. Ordinary fresh entries and stale opt-in remain supported. |

These patches retain conservative runtime hardening based on the upstream reports in
[braces #70](https://github.com/micromatch/braces/issues/70) and
[http-cache-semantics #56](https://github.com/kornelski/http-cache-semantics/issues/56).
The regression tests cover the reported cases and normal behavior. Patch hashes
reject an unpatched or unexpectedly modified install.

The October 29 registry review also requires transitive `@hono/node-server`
2.1.3 for [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)
and `qs` 6.16.1 for [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw).
Bounded overrides in `pnpm-workspace.yaml` replace only affected versions.

## Updating or retiring a patch

Use the pinned pnpm 10.34.7. Keep patches under `patches/` registered through
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
