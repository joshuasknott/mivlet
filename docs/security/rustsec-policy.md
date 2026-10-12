# RustSec policy

`pnpm audit:cargo` runs the policy regressions and `cargo audit` against the
desktop lockfile. Every vulnerability fails the gate. Missing, malformed and
inconsistent reports also fail; no vulnerability exceptions remain.

The October 12 notification update moves `notify-rust` to 4.18.2 and
`tauri-winrt-notification` to 0.8.1. The latter no longer depends on quick-xml,
removing the vulnerable 0.37.5 dependency and the temporary exceptions for
`RUSTSEC-2026-0194` and `RUSTSEC-2026-0195`. Mivlet's own OOXML parsing retains
its patched quick-xml dependency. The former advisories fail the gate if they
ever reappear; their previous reachability exception has been removed.

Cargo audit also surfaces informational maintenance and unsoundness notices
for transitive dependencies. Their count remains visible in gate output; they
are not vulnerability exceptions.
