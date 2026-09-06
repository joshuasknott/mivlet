# Local computer completion and verification

This is the implementation and acceptance checklist for the local computer.
Unchecked items are incomplete; portable tests do not establish native or live
provider acceptance. Architecture lives in
[local teammate computer](../architecture/local-teammate-computer.md).

## Completion checklist

- [x] Review and publish existing legitimate project work before implementation.
  Baseline `c11ea41` on `main`: types, package tests, quality, Rust format and
  Rust tests passed (420 passed, four live tests ignored).
- [x] Review current Cua, KasmVNC and Browser Use documentation and source.
- [ ] Durable control authority; explicit paused expiry/reconnect; cancel or
  drain running operations before human control; fence files and observations.
- [ ] Versioned, persistent Linux image with coding, data and document tools;
  authenticated desktop/browser endpoints and isolated agent processes.
- [ ] Start, stop, restart, reconnect, update, resource limits and idle handling.
- [ ] Low-latency primary viewer, cached conversation thumbnail, practical input,
  accessible focused view, stale frame/input rejection and explicit resume.
- [ ] Structured browser, scoped terminal/files and visual desktop tools through
  supported Fable provider contracts; honest image/tool capability checks.
- [ ] Observe, act and verify; bounded recovery, cancellation and stuck detection.
- [ ] Generated document/spreadsheet artifacts can be received and opened.
- [ ] Native Tauri + real computer + supported provider acceptance journey.
- [ ] Persistence, agent isolation, disconnect, stale input and recovery evidence.
- [ ] Startup/resource/stream/reconnect/task/model usage measurements reviewed.
- [ ] Affected final gates pass; intended source committed and pushed; local HEAD
  verified against the remote branch.

## Acceptance record

At baseline, Docker Desktop's Linux engine returned HTTP 500 on `/version`.
The Docker client was present (29.7.2). No native computer acceptance is claimed
from that prerequisite check. Local baseline logs are excluded under `output/`.

Record actual routes, measurements and material limitations here as acceptance
steps complete. Never store credentials, browser profiles or private user data.

### Lifecycle and artifact regression evidence — 6 September 2026

- The isolated Docker lifecycle test
  `local_computer::lifecycle::tests::real_stop_sleep_restart_and_update_preserve_workspace_and_home`
  passed in 31.79 seconds. It created a fresh labelled test computer, slept and
  woke it, stopped and restarted it, replaced its system container, and verified
  that generated Workspace and agent-home files retained their exact contents.
  The user's saved computer was not used. A subsequent Docker inventory found
  zero Fable-labelled test containers and zero Fable-labelled test volumes.
- Deterministic native authority tests cover idle suspension racing operation
  completion and viewer arrival; the startup-budget test rejects a third
  computer while allowing reuse of an existing slot. This does not measure a
  real 30-minute idle period or prove behavior across Windows sleep.
- Six native artifact tests passed: allowed content types, Office macro and
  embedded-program rejection, opaque scope-bound receipts, traversal rejection,
  actual file containment, and immutable publication copies. Native artifact
  opening through a real conversation remains part of the acceptance journey.
- The viewer-state hook and artifact component suites passed 16 tests, including
  stopped-state frame clearing, takeover/reconnect/scope races, explicit resume,
  thumbnail demand, receipt decoding, native-open errors, and stale error
  suppression. Desktop typecheck and scoped ESLint passed.
- A real-browser component fixture covered light/dark file cards, long titles,
  360px/240px columns, error/disabled states, and keyboard activation. Card
  targets measured 57px high with no internal horizontal overflow. Pending
  native opens retain keyboard focus. This fixture does not establish native
  file opening or the full conversation layout.

The later approval and recovery regressions passed 83 focused desktop tests:
same-owner account refresh preserves a pending approval and its waiter; changing
owner or workspace cancels the gate before hydration; grant-to-native execution
reports actual tool use; unmount cancels the native provider; failed snapshot
reads cannot overwrite saved data; and pending saves cannot follow a scope
change. The snapshot error screen offers Retry and prevents submission until
hydration succeeds. This loading/error screen has not had a native failure
injection check. Desktop typecheck and scoped ESLint passed.

Gemini and native agent-loop suites passed 22 tests, including multiple calls
to the same tool in one stream and across turns, distinct approval IDs, and
provider call-ID roundtrip. This is fixture evidence; no live Gemini run is
claimed. PDF publication and opening are disabled pending a validated sanitizer;
the native regression refuses an automatic-JavaScript PDF and directs the tool
to DOCX, text, or PNG. DOCX/XLSX remain the native acceptance artifact formats.

### Bounded completion pass — 6 September 2026

- Reproduced the native New conversation failure. Saved new-thread drafts contain
  `threadId: null` after native serialization; the renderer now normalizes that
  optional field without relaxing malformed-content or workspace validation.
  Five new draft regressions and three existing snapshot tests passed. Desktop
  typecheck, scoped production ESLint, and the native debug packaged application
  build (`pnpm tauri:build --debug --no-bundle`) passed. The rebuilt native app
  opened New conversation successfully and retained existing conversation history.
  The provider-runtime conformance suite also passed 27 tests, and the rebuilt
  frontend passed the bundle budget check. Staged diff whitespace and a
  high-confidence credential-pattern scan passed; runtime/output paths were
  excluded from staging.
- The acceptance journey stopped at the computer prerequisite. Starting the
  existing Docker Desktop installation failed with `initializing Ingest server`
  because `AppData/Local/Docker/run/sailor-ingest.sock` could not be accessed by
  the system. The Linux engine pipe was absent. No image rebuild, Docker reset,
  provider/model setting change, or credit purchase was attempted.
- Consequently live provider/browser research, XLSX/DOCX creation and native
  artifact opening, human takeover, and explicit return were **not reached** in
  this pass. The complete ordinary-conversation acceptance remains incomplete.
  When the engine was unavailable, the overview still said "Set up computer";
  expanded computer options correctly directed the user to start Docker Desktop.
- Reused recent local logs under `output/local-computer-goal`: repository tests,
  types, quality, bundle budget, dependency audits, Clippy, 446 native tests,
  native packaging, and isolated browser navigation passed. Their relevant
  implementation source was unchanged by this pass except the renderer draft
  fix covered above. `perf-runtime-final.log` is **not** a pass: its native test
  link failed with Windows `LNK1104`. No broad suites were repeated.
- Local logs and temporary files are retained outside the implementation commit.
