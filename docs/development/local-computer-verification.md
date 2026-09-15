# Native computer verification

This records the Windows Cua replacement acceptance on 9 September 2026.
[Architecture and boundaries](../architecture/local-teammate-computer.md) describe
the pinned runtime, global approvals, target identity and saved-file handling.
These checks do not establish cloud hosting or unattended background operation.

## Evidence

| Class | Observed result |
| --- | --- |
| Upstream/source | Official Cua Driver 0.25.0 Windows x64 executable, commit `45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f`; stdio MCP `mcp --direct --no-overlay`, bounded capability manifest, no fork. Archive/executable SHA-256 and publisher signature checked. MIT and transitive notices plus MPL source archives included. |
| Standalone driver | Disposable Windows application was observed, clicked, typed into and scrolled; actual effects inspected. This check preceded removal of the Docker implementation. |
| Live Mivlet/provider | Normal `pnpm tauri:dev`, existing saved account and agent, Codex app-server with GPT-5.6 Luna at High. Under the existing Full Access setting, the model discovered and selected the disposable app without a separate grant prompt, read its screenshot-only gold/yellow triangle and 731, appended text, clicked Confirm, scrolled to later lines, wrote and published `acceptance.txt`. Both fixture effects and Mivlet's artifact preview were inspected. |
| Native boundary | Opt-in live regression passed against the disposable WinForms fixture: exact agent/one-use selection, contention, structured observation, PNG, text/click/keys/scroll, stale rejection, queued Stop, Stop during real driver capture, zero subsequent dispatch, terminated runtime, fresh generation on reconnect, dialog focus loss, target closure, runtime exit and invalidated identity marker. Revocation calls were asserted below 500 ms. |
| Mocked/unit | Authority expiry/revocation, provider tool/image gating, exact global approvals and Full Access persistence, file/artifact scopes, legacy references, pending status after Stop and saved-agent hydration are covered. These tests are not live evidence for other providers. |
| Packaged app | `pnpm tauri:build` produced MSI and NSIS. MSI administrative extraction succeeded; all 14 bundled runtime/license/source files matched source hashes. The extracted application launched with a Windows-only PATH and used its own packaged driver. An ordinary request through the saved Codex provider selected the fixture, observed a screenshot, entered and confirmed `Packaged Mivlet check`, and scrolled the sample; visible effects and the completed response were inspected. This is extracted-package evidence on the existing Windows machine, not a clean-machine installation or upgrade test. |
| Packaged Stop/UI | A fresh request rediscovered the fixture and observed it. The compact native indicator and labelled Stop button were visually inspected over maximized Mivlet while the fixture was foreground. Ctrl+Alt+Esc terminated the exact owned packaged driver. The Computer panel subsequently reported `Stopped with Ctrl+Alt+Esc` and required a new request. The button's mouse-click path was not separately exercised. |

The initial migration's live image claim applies only to the tested Codex
app-server route. At that point no other route advertised screenshot tools.
The subsequent visual-provider expansion and its separate live limitations are
recorded below. External connector writes were not exercised in this acceptance.

Read-only process/service checks found no Docker Desktop, Docker backend or
Windows Docker service running. No Docker engine was started, stopped or queried
through the CLI, and no container, volume, Docker/WSL installation or user file
was removed. This is not an inventory of processes inside every WSL distribution.

Saved agents, existing conversations and provider sign-in remained available in
the live Mivlet session. Compatible old shared Workspace files retain their scope;
legacy computer metadata is marked retired and preserved. Docker-home-only files
require deliberate export by their owner. No automatic volume migration is claimed.

## Repeat the disposable test

Use an interactive Windows x64 session and only non-sensitive test data. Build
`apps/desktop/scripts/native-computer-fixture.cs` as a WinForms executable named
`MivletComputerFixture.exe`, then open it visibly. The native regression requires
its exact PID in `MIVLET_NATIVE_LIVE_FIXTURE_PID`:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml live_actions_stop_queue_and_reconnect -- --ignored --nocapture
```

The test controls only that PID and exact fixture titles. Keep the fixture
foreground while it runs; switching applications correctly revokes its lease.
The fixture contains no account data or network features. Tests are ignored by
default so ordinary test runs cannot take over a user's applications.

For provider acceptance, open normal Mivlet with a validated provider, use the
existing global approval setting and ask the agent to discover the disposable
app. Verify the screenshot-only painted marker, actual text/button/scroll effects
and a published scoped text artifact. Inspect native Stop while the fixture is
foreground and verify a fresh user request is needed after stopping.

## Background delivery expansion, 10 September 2026

This pass retains the bundled Cua Driver 0.25.0 and its exact executable hash.
The production native lease now binds a background or foreground mode.
Background is the default selection; foreground selection remains an explicit
tool approval under the existing global policy, followed by a fresh observation.
Provider image transport from the preceding pass remains in place.

Source review used the bundled Cua commit
[`45d78fed`](https://github.com/trycua/cua/tree/45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f/libs/cua-driver)
and Open Computer Use commit
[`386a260d`](https://github.com/ifuryst/open-codex-computer-use/blob/386a260d1ab8b690adbbb27f7471595cf0c2b752/apps/OpenComputerUseWindows/runtime.ps1).
Cua already provides background delivery through the existing Rust/MCP boundary.
Open Computer Use's PowerShell runtime adds a second integration path without
solving the relevant capture privacy issue: its screen-copy capture can include
covering windows too. Retaining Cua avoids adding another runtime and approval
surface; this is a source-based integration decision, not an all-app benchmark.

The pinned Cua screenshot path can fall back to a desktop crop without exposing
enough capture provenance in `get_window_state` to exclude covering windows.
Background image requests therefore fail before dispatch. Background observations
are structured UIA only. Pixel input, keys, caret editing and WPF `HwndWrapper`
input require foreground selection. Background typing appends with UIA SetValue.
Minimized windows are excluded from discovery and revoke an existing lease.

| Evidence | Result and boundary |
| --- | --- |
| Real Windows fixture | Background selection, UIA observation, text append, button invocation and element scrolling ran with the target fully covered by a second disposable window. Foreground HWND stayed unchanged and the cover text remained untouched. This verifies WinForms controls, not all Windows frameworks. |
| Known refusals | Background screenshot, key and pixel requests caused zero driver dispatches. The action refusals consumed the observation and returned `foreground-required` with `inputDispatched: false`. |
| User interference | The real native input-hook thread started successfully. Direct calls to its target-interference handler preserved control for another window and revoked it for the selected one. This is callback-level evidence, not a physical-user input test. Minimization was exercised against the real fixture and blocked old-generation input. |
| Stop during input | A fixture handler recorded a real UIA text append, then deliberately held that call. Native Stop returned below 500 ms, killed the owned driver, fenced a queued observation, restored NOACTIVATE after process exit and allowed a fresh generation. The final control value and fixture event log proved the uncertain append was not replayed. Already dispatched app work remains non-undoable. |
| Automated regression | Exact selection arguments distinguish background and foreground approvals. The executor requires explicit foreground selection plus observation after a known refusal, and blocks replay of uncertain input across a mode change. A latched native focus test prevents a monitor from consuming takeover detection before a concurrent action. |
| Panel preview | Production component inspected at 1280 × 800 and 390 × 844 for background, foreground and stopped states. No horizontal overflow; narrow Stop target was 44 px tall with visible keyboard focus. Mouse and keyboard activation reached stopped state through a mocked runtime. |
| Existing foreground regression | Explicit foreground selection, observed text entry, keys, button invocation and PNG capture ran. The extended regression then failed at `desktop_tools::delivery_ticket` with `Mivlet's encrypted store is not initialized`. Its later provider-delivery/old-image assertions were not reached in this standalone fixture. No store or provider validation was bypassed; this is an incomplete live regression, not a passing egress test. |
| Repository gates | `pnpm typecheck`, `pnpm test` (1,443 package tests passed, five skipped, plus two Node environment tests), `pnpm quality`, `pnpm verify:build`, Rust formatting, Clippy with warnings denied, and Rust tests (499 passed, five opt-in tests ignored) passed. The background native fixture runs separately. |

Repeat background acceptance by building the fixture and opening a second
instance with `--cover`. Set `MIVLET_NATIVE_LIVE_FIXTURE_PID`,
`MIVLET_NATIVE_LIVE_FIXTURE_COVER_PID`, and `MIVLET_NATIVE_LIVE_FIXTURE_DIR` to
the two disposable PIDs and their dedicated executable directory. Both windows
must be visible and restored. Use a fresh fixture directory for each run so its
synthetic text/event assertions start empty. The test positions and activates
the cover during setup, then measures that background operations leave focus
unchanged. It restores window visibility/stacking when it finishes.

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml live_background_actions_stop_and_refusals --lib -- --ignored --nocapture
```

No packaged/provider-driven background conversation, physical user interference,
WPF/XAML/Chromium live matrix, signed installer, cloud execution or deployment was
verified in this pass. These remain separate acceptance work. No runtime pin,
credentials, provider route, cloud worker, commit, push or deployment was changed.

## Gates and limitations

The final source passed repository typechecking, all package tests (1,426 passed,
five skipped, plus two Node environment tests), quality gates, `pnpm verify:build`,
Rust formatting and Clippy with warnings denied, and Rust tests (487 passed,
three opt-in live tests ignored). The disposable native regression above was run
separately and passed. Performance budgets, performance regressions/runtime checks,
release-manifest tests and `git diff --check` also passed. See
[the repository verification guide](verification.md) for commands.

Audits currently report three moderate Hono advisories inherited
through the unchanged hosted-runner `@cloudflare/sandbox` dependency. The Rust
audit passes with the repository's reviewed exceptions and informational notices.

The driver needs no user-installed Node, Python, uv, Docker, MCP client, daemon
or separate Cua app. Mivlet still needs supported Windows x64/WebView2 and its
account and validated model provider. Provider-specific runtime, network and
entitlement prerequisites remain separate. A build on a developer machine does
not establish a clean-machine installation or every provider route.

At the time of original acceptance (September 2026): no source was committed or
pushed, and no installer was published or installed
over the user's existing installation during this task. Existing account data
was read by the extracted package; the additional disposable acceptance turns
remain in its normal local conversation history. That checkout has since been
committed; the note is historical, not a current publication constraint.

## Visual provider expansion

The later 9 September 2026 implementation adds native screenshot round trips for
the existing direct OpenAI, Anthropic and xAI catalogue routes. The
[adapter matrix](../architecture/local-teammate-computer.md#tool-and-provider-paths)
records every implemented provider adapter, exact supported API models and why
other routes remain unavailable. The original migration and packaged-app evidence
above is historical; it is not a new live pass for this expansion.

### Source inspection

- Rechecked Cua release tag `cua-driver-rs-v0.25.0` against commit
  `45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f`. The bundled executable's SHA-256 is
  `57919fe31bf91b7ff8af35630fdb3d31ed92fd1c333b9e9678a508cecd476719` and its
  Authenticode signature is valid for Cua AI Inc. Neither the executable nor
  the Cua launch/action/foreground configuration changed in this expansion.
- [OpenAI computer-use guidance](https://developers.openai.com/api/docs/guides/tools-computer-use)
  supports retaining existing function/MCP tools and an observe/action/observation
  loop. Mivlet retains its shared schemas and approval controls.
- [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
  permit image blocks inside the matching result and require parallel results
  in the following user message. The streaming regression caught and fixed
  `message_stop` overwriting an earlier `tool_use` stop reason.
- [xAI image input](https://docs.x.ai/developers/model-capabilities/images/understanding)
  and the OpenAI-compatible Chat Completions wire use image content in user
  messages. Native egress inserts the image after the complete set of tool results.
- [ACP content](https://agentclientprotocol.com/protocol/v1/content) supports image
  input/MCP forwarding, but Mivlet's current managed and Antigravity sessions use
  text prompts and provider-owned yes/no permissions without a Mivlet result bridge.
  Those protocols are not described as inherently image-incapable.
- Reviewed [Cua at the bundled revision](https://github.com/trycua/cua/tree/45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f)
  and [the alternative implementation](https://github.com/ifuryst/open-codex-computer-use/tree/386a260d1ab8b690adbbb27f7471595cf0c2b752).
  Useful patterns were bounded image tool results and fresh observations after
  actions; no replacement driver, external tool schema or copied implementation
  was introduced.

### Regression and gate evidence

Mocked provider loops cover OpenAI, Anthropic and xAI observe/action/observation
continuations, exact approval IDs, missing native bindings, unavailable schemas,
Stop after capture and grouped Anthropic parallel results. Native tests cover
exact image/call/result pairing, renderer image injection and replay, fragmented
SSE, scope/generation/single-use claims, incomplete responses, oversized input,
expiry and late capture after cancellation. Transport tests cover session reuse,
native-control-event separation, late session creation after Stop and cleanup on
provider failure. These establish local behavior, not live model acceptance.

Repository types, all package tests (1,440 passed, five skipped, plus two Node
environment tests), quality, production build, performance budgets and regressions,
runtime performance checks, release-manifest tests and Rust compile/tests (496
passed, four opt-in live tests ignored) passed.
Rust formatting, Clippy with warnings denied and `git diff --check` passed.
The pnpm audit still reports the same three moderate Hono advisories through the
unchanged hosted-runner `@cloudflare/sandbox`; it is not a clean full audit.
The separate Cargo audit passed with the repository's reviewed exceptions and
informational notices. No dependency was upgraded to silence the findings.

### Live checks and remaining acceptance

| Check | Result for this expansion |
| --- | --- |
| Direct API credential inventory | Native OS-store check: OpenAI, Anthropic and xAI credentials unavailable. Their new image round trips could not be exercised live. A custom endpoint credential exists, which does not establish its image support or connection health. No secret was printed or passed through JavaScript. |
| Native Windows fixture | Built and opened the disposable WinForms app. The opt-in test stopped at selected-window activation with `Foreground focus changed`. The test's added old-image-after-action/reobservation assertions therefore did not run live. This is a failed/blocked live check, not a passing input or screenshot test. Focus restrictions were not relaxed. |
| Available Codex connection | `codex login status` confirmed ChatGPT sign-in. A separate ephemeral app-server probe on CLI `0.153.4`, default image-advertising `gpt-6-astra`, requested one synthetic image through `local-desktop-observe`. Two attempts failed image-identification acceptance; the observed response reported that no image was visible. The response shape matches the installed generated `DynamicToolCallResponse` schema (`inputImage`/`imageUrl`). This probe does not prove current Codex image understanding or the normal Mivlet UI path. |
| Saved data and publication | The Codex probe used synthetic pixels and an ephemeral session; it did not capture personal windows. The disposable app and probe processes were closed. Cua, foreground behavior and cloud execution remain unchanged. No commit, push, deploy or package publication occurred. |

Repeat the real native fixture test in an interactive session that can retain
foreground focus. With each supported direct API connected, run an ordinary
Mivlet conversation against that fixture, verify its screenshot-only marker,
then verify a fresh screenshot after a harmless action and immediate Stop.
Current live acceptance remains outstanding for those routes. The Codex
synthetic-image failure also needs a successful current-runtime repeat before
extending the earlier migration's live claim to this default model/runtime.

The read-only direct credential inventory is opt-in:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml live_visual_provider_connection_inventory --lib -- --ignored --nocapture
```
