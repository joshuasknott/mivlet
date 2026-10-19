# Native startup and memory observation

Use an executable built from a known commit, verify its receipt/hash, and record
whether it is a debug acceptance build or an optimized packaged build. Build
time is not app startup time. A debug executable needs its matching renderer
served on the configured development URL; use built assets to avoid measuring
Vite dependency compilation. Keep the renderer server warm and identical across
comparisons. Do not substitute an old local binary for the tested commit.

For an optimized measurement build, dispatch Full validation with
`bundle_profile=true` and `native_release=true`. An optional full
`baseline_commit` builds that ancestor before the requested head with the same
dependency lockfiles and toolchain. The `native-release-<head>` artifact contains
one directory per completed source commit, including the release executable,
embedded production renderer and the native resource layout. Failed jobs retain
completed builds for diagnosis. Before comparing, require `comparison.json` to
have `complete: true` and the exact expected head and revision set, then verify
every file against its receipt before launching. No development server is needed. These unsigned
artifacts exercise release code without installing over the user's application;
they do not establish signed-installer or installation-lifecycle acceptance.
The profile workflow does not replace required PR checks or full validation.

Close Mivlet normally before each run, then on Windows run:

Keep the desktop unlocked. The observer starts the measured app with a normal,
visible window; hiding it changes WebView activation and can invalidate startup
observations. The sampler itself stays hidden. Discard a run that becomes
unresponsive or never reaches the intended workspace, even if it initially
exposed a titled native window.

Keep Mivlet unobscured while recording workspace readiness. A missing
accessibility tree under another foreground window is an invalid observation,
not evidence of an app hang. Retain failed and obstructed runs with their reason;
do not replace their missing readiness time with zero or silently exclude them.

```powershell
node scripts/perf/native-observation.mjs --exe C:/path/to/mivlet-desktop.exe --duration 60 --output output/native-run.json
```

For the existing development account configuration, add
`--env-file apps/desktop/.env.local`. The observer applies it to the native
process environment without saving or printing the values. Do not export vault
contents or copy credentials into fixtures. The app remains open after the
observation, including after a measurement error; close it normally before the
next run. A failed/early-exit observation produces a failing exit code and a
structured report, not a successful zero-memory measurement.

The launch receipt records the executable SHA-256, PID, launch time and explicit
working directory (the observer's current directory). Use the same directory
for both builds and ensure no Mivlet process is already running before launch.
`firstResponsiveWindowMs` is the first sampled responsive native window titled
Mivlet. It is **not** first paint, provider readiness or a usable workspace.
Verify the visible native screen separately. Record which state was reached:
signed out, provider setup or an authenticated workspace. Do not compare unlike
states or infer live provider latency from shell readiness.

Memory samples include only the launched process and its observed descendants,
identified by PID and creation time. Other applications' WebView processes and
the measurement/server processes are excluded. Working-set totals can count
shared physical pages more than once; private bytes measure private committed
memory, not resident RAM. Peaks use simultaneous totals; settled medians use the
second half of the observed interval. Brief children between one-second samples
can be missed. The observer bounds its own wait and does not terminate the app.

Take a first observed launch and at least three repeated warm launches using the
same profile, executable mode, window state and idle interval. Report machine
RAM pressure and concurrent workload. A first observed launch is not a cold-boot
benchmark: OS and WebView caches have not been cleared. Keep the individual
samples, report medians/ranges, and avoid claiming speedups smaller than the
measurement noise. Store reports under ignored `output/`.

Run `node --test scripts/perf/native-observation.test.mjs` for process attribution
and statistics regressions. The same suite is included in `pnpm perf:test` and
the full validation gate. These deterministic tests do not replace a real native
observation.

## Window startup recovery

The configured main window is created explicitly before account initialization.
Its WebView2 completion waits share a 60-second deadline. A failed or timed-out
creation offers a native retry/close dialog; retry starts a fresh process and
repeats normal account admission. No workspace workers start after a creation
failure, and an existing workspace is never automatically reloaded or replayed.

A later fatal exit of the main renderer or WebView browser closes the pinned
account session and stops its workers before offering restart or close. Failures
during setup wait until worker registration finishes so cleanup cannot race a
late worker start. Subframe, GPU and utility failures or an unresponsive renderer
do not trigger this global teardown. Restart is explicit and repeats normal
account admission; it does not automatically replay agent actions.

The pinned `webview2-com` patch pumps COM callbacks and window messages, detects
disconnected completion channels, and bounds only waits within that startup
scope. Other operations retain their existing timeout policy. Its source and
review notes are in `vendor/webview2-com/PATCH_NOTES.md`; Windows CI runs the patch's
own wait regressions in addition to Mivlet's native suite.

`[mivlet-startup]` stderr records contain only fixed stage names, elapsed
milliseconds and WebView2 process-failure kinds. They exclude URLs, account
identifiers and underlying error strings. `page_finished` means navigation
completed; it does not establish account, provider or workspace readiness.
The earlier low-memory blank launches are consistent with a pre-setup WebView
creation stall, but do not establish whether memory pressure or COM callback
delivery was its cause. A bounded failure path is distinct from proving that
Windows can create a renderer with insufficient memory.

## Codex discovery memory

Auth and model discovery share one fresh, supervised Codex app-server. Discovery
uses a temporary working directory with project documents, MCP servers and turn
tools disabled; actual agent turns keep their existing execution configuration.
The metadata reader accepts at most 1 MiB per line and queues at most eight raw
frames before parsing. Oversized metadata fails closed with a clear error. The
bound applies to metadata, not conversation output, and protects Mivlet's heap
from an unbounded provider stream.

Distinguish that buffer from the provider process's own memory. On the observed
Codex 0.163.0-alpha.10.2 Windows runtime, fresh authenticated discovery still peaks
near 518 MiB of private committed memory. Public source ties the encrypted
credential path to age/scrypt; this is source-correlated evidence, not a heap
trace. Isolating discovery did not remove that allocation in controlled probes.
Keep account verification fresh and preserve the provider-owned keyring store.
Do not substitute stale authentication, plaintext credentials or weaker
encryption to claim a lower startup peak. Re-measure after provider runtime
changes and report provider and Mivlet process memory separately.
