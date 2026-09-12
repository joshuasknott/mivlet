# Native Windows computer

Mivlet uses existing Windows applications in the user's interactive session.
This replaces the retired Docker Linux computer. Supported accessibility controls
can run in the background; other operations require explicit foreground selection.
It is not a VM, separate desktop, host-code sandbox or unattended computer.
Prefer an existing connector when it can complete the task without desktop input.

## Integration and distribution

The native boundary supervises the official Windows x64 Cua Driver **0.25.0**
release from tag `cua-driver-rs-v0.25.0`, commit
`45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f`.
[Upstream source](https://github.com/trycua/cua/tree/45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f/libs/cua-driver)
and the [release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.25.0)
are the supported integration references. No fork or upstream patch is used.

`local_computer/cua.rs` starts `cua-driver.exe mcp --direct --no-overlay`
using upstream's stdio MCP interface. It does not install Cua's separate agent,
start its daemon, register login tasks, or expose a network listener. Each grant
has its own process, private temporary configuration, bounded permission
manifest, and Windows kill-on-close job. Only Mivlet-owned processes are stopped.
The inherited environment is cleared; only required Windows paths are retained.
Optional telemetry and update checks are disabled by documented flags.

`resources/cua-driver/runtime.json` pins the archive and executable hashes.
`prepare-cua-driver.mjs` verifies both hashes and the Cua AI Inc Authenticode
signature before installing the build resource. The native boundary verifies the
executable hash again and holds a deny-write file handle while it is running.
The normal `pnpm tauri:dev` and `pnpm tauri:build` flows prepare this resource.
Release resources resolve relative to Tauri's resource directory; development
uses the source resource directory.

The executable imports Windows system libraries. Native computer use requires
Windows x64 and the installed Mivlet application, including WebView2; it does not
require user-installed Docker, Python, Node, uv, an MCP client or a Cua app.
Build tools and the selected model provider's own prerequisites remain separate.
Missing or incompatible resources fail closed with repair guidance.

Cua's runtime is MIT licensed. The bundle includes its license, a target-specific
normal/build dependency inventory, transitive notices, Inter's OFL notice, and
exact source archives for MPL-covered crates. The collector uses the pinned
Cargo.lock and verifies source hashes. These files accompany the executable;
regenerate and review them when changing the upstream pin. The upstream SDK DLL
is not used or bundled. Cua cloud services and orchestration are not dependencies.

## Permission and input

Computer Use follows the existing global approvals setting. Full Access resolves
exact single-use tool approvals automatically; other modes use the existing
approval queue. There is no separate per-app permission prompt. The agent lists
open applications and selects an opaque window ID itself, asking only when the
user's intended target is ambiguous. Native execution consumes the exact approval
and binds workspace, agent, request, window identity and turn generation. Only
one Mivlet agent can hold computer control at a time, in either delivery mode.

Window identity includes PID, process creation time, HWND, thread and class. A
random native window property detects HWND reuse even within one process.
Inaccessible, protected and elevated targets fail closed. `local-app-select`
defaults to `deliveryMode: "background"`. Selection and supported element actions
do not activate the target. A foreground operation requires a new exact selection
with `deliveryMode: "foreground"` under the existing approval policy, then a new
observation. The native lease fixes the mode; action arguments and driver hints
cannot change it. Full Access continues to resolve exact approvals automatically.

Both modes require the exact window to remain open, visible, non-minimized and
unreplaced. Mivlet never restores minimized windows automatically. Foreground
mode revokes on focus loss. Background mode allows work in other applications,
but revokes when the target or an owned popup becomes foreground, or when native
input hooks detect physical typing/clicking/scrolling in the target. The hooks
retain only the target HWND, never keys, text or input history. Already active
windows can be selected in background mode; physical input still stops control.

Background `local-app-observe` returns accessibility structure without an image.
Element clicks, append text via UIA SetValue, and element scrolling are attempted
with Cua's background mode. Text appends to the control's value, not the caret;
caret editing needs foreground mode. Screenshots, pixel actions and keys require
foreground mode before dispatch. WPF `HwndWrapper` input also requires foreground
because the pinned driver documents self-activation in those providers. Other
apps can reject background input; support is per control, not guaranteed by an
application name.

A native preflight refusal returns `foreground-required` with
`inputDispatched: false`, consumes the observation, and does not call Cua. The
executor then requires explicit foreground selection and observation before any
mutation. A Cua error, timeout or disconnect is an uncertain outcome: revoke,
do not replay, and require a fresh user request to inspect the result. Driver
`background_unavailable` is not proof that no input occurred. No error silently
switches mode or repeats input.

The compact native activity window has a Stop button and a global Ctrl+Alt+Esc
shortcut. It runs on its own Windows message thread and does not depend on React,
the model, a driver reply or accessibility calls. Missing Stop support prevents
a grant, as does failure to install the native input hooks. Stop removes the active grant and observations, cancels operation
tickets, advances the durable generation, terminates the owned driver, and drains
old work. Queued input cannot acquire a new grant. Input already handed to Windows
may have taken effect and cannot be undone; unknown outcomes are never retried
automatically. Runtime failure, restart and reconnect require a fresh user turn,
current discovery and another exactly authorized selection. A stopped turn cannot
silently obtain a new lease, including under Full Access. If background input was
in flight, a separate cleanup worker waits for the killed process to exit before
restoring Cua's temporary NOACTIVATE flag and, for the pin's XAML/Chromium shield,
enabled state. Identity is checked again and real modal owners remain disabled.
New selection stays blocked until cleanup succeeds; Stop never waits for UIA or
window restoration. Already submitted application work can still complete.

Authority checks surround transport dispatch and response. One request is
outstanding per driver. The dispatch fence and owned process termination are
independent of the response lock, so a blocked accessibility provider cannot hold
Stop behind its reply. Responses from retired grants are discarded. Permissions
expire after 30 minutes or five minutes of inactivity; observations expire after
30 seconds, are consumed once, and are invalidated by window size changes.

This is an authorization boundary, not application sandboxing. A permitted app
can access files, navigate or send information through its own UI. Dialogs and
shortcuts may change context. Mivlet restricts keys and checks the selected
window and delivery mode, but cannot make the shared desktop equivalent to a VM.
Users must finish password and private sign-in steps themselves; detected password
fields or credential-shaped text stop observation. Arbitrary sensitive screen
content cannot be reliably classified, so choose non-sensitive windows.

## Tool and provider paths

The driver is private to Rust; React receives no driver methods, process handles,
raw accessibility tokens or screenshots. Native code only exposes:

- `local-app-list/select`: scoped discovery and exact window selection through
  the ordinary global approval boundary.
- `local-app-observe`: bounded untrusted accessibility text and opaque controls.
- `local-app-action`: click, bounded non-secret text, scrolling and navigation keys
  tied to one fresh observation. Results report input dispatch and require a new
  observation to confirm the actual effect.
- `local-desktop-observe/action`: the same target and authority with a bounded
  window PNG, delivered natively by a supported provider adapter.

Structured tools require an actual connected provider/model route with Mivlet
tool execution support. Image input metadata alone cannot enable screenshots.

| Implemented adapter/route | Image and tool response path | Screenshot availability |
| --- | --- | --- |
| Codex app-server | Existing pending dynamic-tool claim and native `inputImage` response | Models advertising image input in the current runtime catalogue |
| Direct OpenAI API | Chat Completions tool results remain together; native code inserts a labelled `image_url` user message immediately after them | `gpt-5.2`, `gpt-5`, `gpt-4.1` with current tool/vision capability and route checks |
| Direct Anthropic API | Native base64 PNG inside the exact `tool_result`; parallel results share one following user message | `claude-sonnet-4-6`, `claude-opus-4-8` with current tool/vision capability and route checks |
| Direct xAI API | OpenAI-compatible Chat Completions image message after all tool results | `grok-4` with current tool/vision capability and route checks |
| Direct OpenRouter API | Text/tool transport over the OpenAI-compatible chat route; the model id selects the exact OpenRouter route and Mivlet adds no fallback | Unavailable pending route-specific verification, even when model metadata lists image input |
| Custom API endpoint | Text/tool transport; endpoint configuration establishes neither image support nor an audited image profile | Unavailable, even when model metadata claims vision |
| Managed Claude, Cursor ACP, Grok ACP, OpenCode | Provider-owned execution and yes/no permission responses; current Mivlet handles have no shared tool-result/image channel | Unavailable; requires a native Mivlet tool bridge, not a vision flag |
| Antigravity ACP | Text prompts and provider-owned permission decisions; sessions currently register no Mivlet MCP servers | Unavailable for the same bridge reason |
| Direct Gemini API | Text and tool turns exchange `functionCall`/`functionResponse` parts inside Gemini `contents`; the API key stays in the Rust egress header | Unavailable; no audited native screenshot bridge exists for this route, and vision metadata alone never enables one |

The managed/ACP restriction describes Mivlet's current adapters, not an upstream
claim that ACP, MCP or those models cannot carry images. Current ACP content
supports images and MCP forwarding, but no such native bridge is configured here.

Direct API sessions bind the installation identity, persisted provider route,
model, workspace, agent and computer generation. Rust reconstructs completed
provider tool calls from bounded SSE and issues opaque single-use approval IDs;
renderer-authored tool calls cannot authorize screenshot capture. Existing global
approvals still authorize the exact tool and arguments. The native screenshot
is paired with the exact unmodified tool result before one HTTP request, with no
automatic image retry. It is discarded after consumption, cancellation or a
30-second delivery timeout. Only one screenshot request per provider response
is accepted. The renderer and durable transcript contain observation metadata.

At capture and again before egress, native code checks the current generation,
selected-window identity, selection ID, latest unconsumed observation, dimensions,
privacy state and foreground lease. Stop cancels the provider request and retires
pending calls; late captures cannot restore a closed session. Replacing an
observation or dispatching input prevents delivery of the old screenshot. A fresh
observation confirms effects after input. Normal provider-session cleanup leaves
the existing computer-control policy unchanged.

Each real tool needs Mivlet's exact single-use tool approval. Provider authentication and credential
custody remain in existing adapters. There is no local shell, registry access,
arbitrary driver invocation, inherited plugin execution or cloud fallback.
Hosted browser/process tools retain their separate deployment boundary.

## Files and saved computers

The scope hash and `local-computers/<scope>/workspace` directory are unchanged.
File listing, reading, writing, repository ZIP import and artifact publication
remain confined to this explicit Mivlet-owned scope. Paths are relative; legacy
`/home/fable` or `/home/agent` paths never become arbitrary host filesystem access.
Artifacts retain strict type/content validation and immutable publication copies.
Opening an artifact writes a fresh private launch copy of the receipt-verified
bytes and re-verifies that exact copy against the receipt digest immediately
before the system association opens it. This detects replacement between
preparation and verification; the path-based system launch still leaves a race
between verification and the associated application's open.
The removed Linux image no longer supplies office, coding or shell programs.

Two native-boundary tools author a narrow passive Office subset without launching
Microsoft Office, a scripting language or a process. `create-document` accepts a
title plus bounded headings, paragraphs, bullets and tables. `create-spreadsheet`
accepts at most eight sheets and 100,000 cells; formula cells are limited to
same-sheet `SUM`, `AVERAGE`, `MIN`, `MAX` and `COUNT` over earlier A1 ranges of at
most 10,000 cells. Rust calculates the cached formula result. Both tools write a
temporary OOXML package, reopen it through the existing macro, embedding and
external-relationship validator, and only then place it at a new publication-safe
workspace path. `computer-artifact` remains a distinct, explicit publication step.

Repository ZIP import has a different boundary. It creates a sanitized private
snapshot for bounded file reads and explicit text edits. It does not initialize
Git or connect that snapshot to the hosted process workspace. Build, test and diff
claims therefore remain unavailable for an imported snapshot until Mivlet has a
separately approved repository transfer into a configured cloud computer. The
native UI and agent instructions state this prerequisite rather than treating ZIP
import as execution evidence.

`native-control.json` stores only generation and the retired-computer marker.
Loading a compatible legacy `control.json` advances its generation, marks the old
computer retired and preserves the complete old file. No input permission is
persisted. The UI explains that former shared Workspace files remain accessible
in Files. Files saved only in Docker home volumes require a deliberate manual
Docker export. Mivlet does not start/stop old containers, delete volumes, uninstall
Docker/WSL or automatically migrate private browser profiles. Existing agents,
conversations, provider sign-ins and hosted foundations keep their identities.

## Evidence

See [native acceptance evidence](../development/local-computer-verification.md).
Standalone driver probes, native-boundary tests, mocked provider tests, live
Mivlet conversations and packaged-app checks are separate evidence classes.
No passing import, build or mock establishes live provider image understanding,
input cancellation or packaged installation acceptance.
