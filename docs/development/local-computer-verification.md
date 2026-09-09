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
  supported Mivlet provider contracts; honest image/tool capability checks.
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
  zero Mivlet-labelled test containers and zero Mivlet-labelled test volumes.
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

### Native acceptance follow-up — 6 September 2026

- Docker became available. The saved agent computer started through Mivlet and
  reported healthy; the native viewer showed Chromium. Human takeover and
  explicit return switched the viewer between human control and watching.
- A user-submitted public Python research and DOCX/XLSX task failed after Retry
  with `Blocked by Mivlet's read-only permission mode`, although the composer
  displayed Full access. The user confirmed using Retry. Its hook hardcoded
  read-only; the retry action now supplies the current permission mode. It
  starts a new attempt and retains fresh tool approvals rather than reusing
  historical approval IDs. Default callers without an explicit mode remain
  read-only.
- The 33 native-agent hook tests passed, including regressions for full-access
  and read-only retries. Another 26 focused tests passed for computer state,
  artifacts, task execution and shell approvals. Desktop typecheck and scoped
  ESLint passed.
- The real lifecycle test passed in 24.28 seconds. The real container isolation,
  document generation, process cancellation and persistence test passed in
  20.20 seconds. Both use separate test resources.
- The three-test live browser command stalled in its first test,
  `real_agent_navigation_uses_the_isolated_browser_and_returns_no_frame`, and
  was interrupted without a result. Its remaining labelled test container was
  stopped. This is not a pass.
- The Windows automation helper could read the app but returned
  `coordinate input geometry is unavailable` for native controls and a UIA
  CacheRequest error for setting the composer value, including after reconnect.
  The user submitted the test prompt manually. Full live research, artifact
  publication/opening and repeated end-to-end tasks remain incomplete.
- The fixed frontend production build and bundle budget passed. The native
  rebuild could not replace `target/debug/fable-desktop.exe` because the old
  app remained running (`Access is denied`, Windows error 5). Normal closure
  was requested after the automation helper also failed on the Close button.
  The Retry fix is not yet present in the running native app.

### Full access follow-up — 6 September 2026

- After normal app closure, the native rebuild succeeded. A live task then
  exposed a second issue: Full access still queued interactive approvals for
  each computer action. Full access now resolves each exact tool authorization
  automatically through native persistence; Ask first keeps its queue. Native
  failures, permission downgrades, cancellation and workspace changes do not
  release the pending action. The permission description matches this behavior.
- Nine shell approval tests and 33 native-agent tests passed, including automatic
  authorization, native failure, permission downgrade, workspace change and Retry.
  Desktop types, scoped production-source ESLint, production frontend build,
  performance budget and native debug build passed. The updated app was launched.
- Screenshot-coordinate interaction worked after raising the Mivlet window;
  accessibility-index clicks remain unreliable. The live acceptance task was
  submitted through the composer using the user's selected GPT-5.6-Luna High.
  Browser and short shell actions completed without interactive approval. File
  creation failed with `Execution blocked: approval metadata changed after the
  user decision.` Native approval resolution shortened/normalized the request
  before recording its fingerprint, while execution supplied the original.
- Native resolution now retains the exact unmodified request for the permit;
  audit display normalization remains bounded. A long multiline regression proves
  unchanged content executes, changed suffixes fail and permits remain single-use.
  All 447 enabled native tests passed (six live tests ignored), along with Rust
  formatting and all-target/all-feature Clippy with warnings denied.
- The subsequent live agent run created both files through the isolated shell,
  reported reading both back and returned two working artifact cards in the
  conversation (XLSX 8 KB, DOCX 37 KB), with no approval interaction. Direct
  `write-file` exposed a missing confirmation field in the desktop dispatch
  resolution; that dispatch now uses the shared exact resolution builder. All
  22 desktop tool executor tests passed, including the forwarding regression.
  External opening of the returned copies and repeated complete tasks have not
  yet been verified. The lifecycle controls also have a narrow-layout defect
  visible when Computer options is expanded; this pass does not fix that layout.

### Daily-driver implementation evidence — 7 September 2026

- Browser and Computer built-ins now have native enablement/admission checks,
  a shared lazy-start path and revocation/draining on disable. Browser-only
  access does not grant desktop or shell tools. The 51 focused desktop tests
  and native admission regression passed. The actual marketplace and composer
  components were inspected at desktop and 390px widths in the labelled
  browser preview. This does not exercise native enablement through the UI.
- A direct ephemeral Codex app-server probe on the connected default
  `gpt-6-astra` route performed a fresh search with 18 structured results,
  then opened a returned page with one result and a linked citation. Shell,
  unified execution, memories, apps and MCP were disabled in that probe.
  It did not use the packaged Mivlet conversation. Public URL fetching now
  returns readable content and bounded source metadata under existing SSRF,
  redirect and body limits. Other provider routes still lack dedicated search.
- The document guest image generated DOCX, XLSX, PDF and PPTX, recalculated the
  workbook and rendered Office/PDF outputs. Eight focused native artifact
  tests and the opt-in real-fixture test across seven files passed. Rendered
  fixture pages/slides were visually inspected for clipping/overlap; the XLSX
  formula `SUM(A1:A2)` had cached value `5`, matching its expected result.
  These are simple fixture checks, not arbitrary-document layout guarantees.
  Native external opening from an ordinary conversation remains unverified.
- Four native repository import tests passed for scoped extraction, common
  credential/dependency exclusions, traversal and case collisions. A separate
  read-only-mounted synthetic repo ran inside image
  `sha256:32cf0a743af2f566f5c28008bf77e83c35012d94958b9d48991fad6e3dbcf1f9`:
  its baseline test failed, an isolated Git worktree fixed one source file,
  the test and `git diff --check` passed, and the original source, unrelated
  tracked file and untracked scratch file retained their contents. Network was
  disabled. No remote write or PR was attempted. The native chooser-to-chat
  journey is not covered by this probe.
- Interrupted-attempt checkpoints preserve intent, successful tool results and
  uncertainty while dropping reusable authority identifiers. Unused persisted
  approvals are invalidated on recovery. Focused tests cover bounded recovery,
  uncertain-write replay prevention and current-route retry behavior; real
  crash/restart and consequential external-write reconciliation remain open.
- Memory Settings now supports inspect/correct/disable/forget. The correction
  test rejects stale revisions and forgotten records; two UI tests cover save
  errors and management filtering. A labelled synthetic preview exercised
  correction at desktop and phone widths. Native state-change and final broad
  gates are still being completed; no packaged memory acceptance is claimed.

The Linux Docker engine was available for these isolated checks. Native app
automation was unavailable in this session, so private sign-in takeover,
packaged conversation delivery and repeated end-to-end completion remain open.
All implementation changes remain uncommitted in the isolated worktree.
