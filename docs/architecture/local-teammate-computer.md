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

### Codex subscription images

Codex conversations use the provider's built-in image generator through the
user's ChatGPT sign-in. These consume the subscription's Codex allowance;
Mivlet does not offer the separate metered `generate-image` / `edit-image` API
tools on Codex turns, even when an OpenAI API key is connected. Other supported
model routes retain the explicit, approval-gated direct API image tools.

`codex_images.rs` imports completed `imageGeneration` app-server items from
their base64 PNG `result`. It validates complete PNG data, CRCs, dimensions and
decode limits before publishing through the existing immutable artifact store.
It never reads `savedPath` or sends raw provider image data to the renderer or
conversation history. The conversation persists an artifact receipt and shows
an openable file card; its preview displays the image.

Delivery requires a saved agent, enabled Computer Use, a current generation and
write access. No desktop window selection or foreground control is needed.
Thread/turn identity, duplicate-item checks and Stop fence every import.
Missing image data, quota failures and rejected imports produce failed activity
instead of a successful image receipt. There is no paid API fallback. The wire
contract was checked against Codex CLI 0.155.0-alpha.2.6; fixture tests do not
establish a user's live subscription entitlement.

To test: connect ChatGPT/Codex, enable Computer Use, choose Ask Me or Full Access,
and request a logo in a new message. Open the generated image card, then reopen
the conversation to check persistence. Also test Stop while generating and a
second request after Stop. Leave the OpenAI API disconnected to verify the
subscription-only route. Merge only after the live image is visible and usable.

### Windows application control

Computer Use follows the existing global approvals setting. Full Access still
queues the same exact single-use tool approval; high-risk minting requires a
native OS confirm, and WebView cannot mint by echoing a confirmation phrase.
Other modes use the existing approval queue. There is no separate per-app permission prompt. The agent lists
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

`local-browser-open` launches installed Chrome or Edge with a private profile
outside the agent's `workspace/` directory. The foreground-only operation uses
the same exact approval, workspace/agent generation and installation-wide
exclusive control reservation. Opening grants no input authority: the agent must
list, select and observe its window normally. At most four browsers are owned by
one account, with one per agent. Closed browser instances can be reopened without
replaying the previous request.

Native code accepts only protected system installations, pins the executable,
checks its Authenticode publisher, clears inherited provider/shell configuration,
and assigns a suspended process to an account-owned job before allowing it to run.
Root, scope and profile directory handles prevent replacement during its lifetime.
No debugging TCP endpoint is enabled. A separate native helper runs before
account/provider initialization and verifies its actual parent and executable.
The main app's pipe handles are never inheritable; the helper pulls only its
parent-owned local pipe clients and passes exactly two handles to Chromium.
The account-owned job is attached to launch Stop while the helper is suspended,
before it can start Chrome. Successful publication detaches this temporary Stop
link, leaving browser ownership with the account. Parent I/O is overlapped and
cancellable without holding the authority or response lock. A bounded, fixed
`Browser.getVersion` probe proves the private pipe protocol before publication;
no CDP methods or JavaScript are exposed to agents. The pipe stays native-owned
across input-driver Stop. The profile is independent of the user's
usual browser profile, but the window still shares the interactive Windows session.
The published browser outlives the input driver and Stop for human takeover;
unpublished cancelled launches are closed, and account/app shutdown closes the
owned browser job. DOM control and native upload/download custody remain pending.

Shared `local-browser-tabs` and `local-browser-observe` provide text reads in the
agent's owned browser through the same selected-window lease and global approval
policy. A sole visible native main window and a sole Chromium window identity must
agree; extra or minimized tab windows fail closed. Owned menus/tooltips are not
read, and popup password metadata pauses observation. Native tab references expire after
60 seconds, bind the window and generation, and are consumed once. The observation
request names one exact HTTP(S) origin. Native code checks its live URL and security
origin, frame and loader before and after reading. It never exposes raw target or
session identifiers, debugging methods, JavaScript, field values or subframes.

The read projection bounds the tree to 2,000 nodes, its output to 200 labels and
16,000 text characters, and the operation to 15 seconds. Editable descendants are
omitted, including editable field names that may embed entered values. Native field metadata pauses reads for password, OTP or payment fields;
credential-shaped output is refused. Page text remains explicitly untrusted.
Reads invalidate older desktop action observations. A cancelled or malformed pipe
exchange disables further agent commands while keeping the pipe handles alive for
human use; close that private window and open a fresh browser to resume agent reads.
DOM actions and native upload/download custody remain pending.

`local-browser-tabs` also captures document-bound `navigationRef` choices, valid
for 30 seconds and one use. `local-browser-navigate` requires an explicitly
selected foreground window, the exact listed source origin and an approved HTTP(S)
destination URL. Only an opaque `about:blank` document can bootstrap
navigation; HTTP(S)-inherited blank documents and internal/file/data URLs fail
closed. Native code rechecks the window, target, source origin, frame, loader and
full URL before dispatch, then invalidates all older tab and navigation choices.

Navigation starts one bounded overlapped pipe write while holding the current
control and generation fences. Account expiry/generation/open/deadline checks run
inside that dispatch fence. Credential reads happen beforehand; the identity
check uses a nonblocking lock and cached expiry and refuses a busy or changed
identity. It never waits, flushes or retries a partial write under those
locks; cancellation and response waits happen outside them. The fixed native
`Page.navigate` call sends no referrer or JavaScript. A successful reply means
only dispatched, not verified page load: the agent must list and observe again.
Errors, downloads and interrupted replies have uncertain outcomes and are not
replayed. Browser-managed downloads are not imported or presented as Mivlet
artifacts; native transfer custody and DOM element actions remain pending.

The driver is private to Rust; React receives no driver methods, process handles,
raw accessibility tokens or screenshots. Native code only exposes:

- `local-app-list/select`: scoped discovery and exact window selection through
  the ordinary global approval boundary.
- `local-app-observe`: bounded untrusted accessibility text and opaque controls.
- `local-app-action`: click, bounded non-secret text, scrolling and navigation keys
  tied to one fresh observation. Results report input dispatch and require a new
  observation to confirm the actual effect.
  Named shortcuts provide select-all/find in the selected app and address-bar,
  browser-back, browser-forward and browser-reload in recognized browser processes.
  Native process discovery determines browser recognition, never window titles
  or caller labels. Every shortcut requires foreground selection and consumes a
  fresh observation; background refusal sends no input. Arbitrary key combinations
  are not accepted. After selecting all, observe before typing into the same field;
  foreground typing replaces the selection where the app supports it.
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
| Managed Claude SDK | Turn-scoped Mivlet MCP tools and text results through the native SDK control channel; built-in Claude tools are disabled | Unavailable; requires audited native image custody and delivery |
| Cursor ACP, Grok ACP, OpenCode | Provider-owned execution and yes/no permission responses; current Mivlet handles have no shared tool-result/image channel | Unavailable; requires a native Mivlet tool bridge, not a vision flag |
| Antigravity ACP | Text prompts and provider-owned permission decisions; sessions currently register no Mivlet MCP servers | Unavailable for the same bridge reason |
| Direct Gemini API | Text and tool turns exchange `functionCall`/`functionResponse` parts inside Gemini `contents`; the API key stays in the Rust egress header. Local wire loop, not the embedded host ([Gemini provider](gemini-provider.md)). | Unavailable; no audited native screenshot bridge exists for this route, and vision metadata alone never enables one |

The managed/ACP restriction describes Mivlet's current adapters, not an upstream
claim that ACP, MCP or those models cannot carry images. Current ACP content
supports images and MCP forwarding, but no such native bridge is configured here.

Claude's bridge follows the [upstream SDK control transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)
and SDK MCP server configuration. Adapters transport calls; the shared Mivlet
registry, permission policy and existing native executors implement their behavior.
There is no second provider-specific tool implementation. The native bridge binds
each result to its account, active turn and opaque single-use call identity, limits
calls and frame sizes, and rejects cancelled, stopped or replayed calls. Calls are
checked again after waiting for approval. Ambient tools, MCP configuration and
settings are disabled. Protocol fixtures establish framing and authority behavior;
they do not establish a live Claude subscription run or screenshot delivery.

Composer uploads use a separate path: Codex and the official Claude SDK aliases
`sonnet`, `opus` and `haiku` accept current-message PNG/JPEG/WebP inputs. The native
adapters share the four-image, 1 MB total, 8192-pixel bounds, local base64 format
and declared byte/dimension checks. Claude sends inline `image.source` blocks in
its initial SDK user message; Codex stages the same validated bytes for one turn.
Historical pixels and unsupported managed routes fail before provider dispatch.
Mivlet stores attachment metadata only; retries require reattachment. This path
grants no screenshot tools. Claude Stop terminates its supervised turn directly,
without waiting for a blocked stdin payload writer. Wire and real subprocess
fixtures establish local framing and cancellation; live Claude account acceptance
remains unverified. See the [SDK user-message transport](https://github.com/anthropics/claude-agent-sdk-python/blob/9c69ce7aced5cdf2aa1ac86fe62e877b4962de8b/src/claude_agent_sdk/_internal/query.py)
and [Anthropic image content format](https://platform.claude.com/docs/en/build-with-claude/vision).

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
`/home/mivlet` or `/home/agent` paths never become arbitrary host filesystem access.
Artifacts retain strict type/content validation and immutable publication copies.
Opening an artifact writes a fresh private launch copy of the receipt-verified
bytes and re-verifies that exact copy against the receipt digest immediately
before the system association opens it. This detects replacement between
preparation and verification; the path-based system launch still leaves a race
between verification and the associated application's open.
The removed Linux image no longer supplies office, coding or shell programs.

Three native-boundary tools author a bounded passive Office subset without launching
Microsoft Office, a scripting language or a process. `create-document` accepts a
title plus bounded headings, paragraphs, bullets and tables. `create-spreadsheet`
accepts at most eight sheets and 100,000 cells; formula cells are limited to
same-sheet `SUM`, `AVERAGE`, `MIN`, `MAX` and `COUNT` over earlier A1 ranges of at
most 10,000 cells. Rust calculates the cached formula result.
Sheets can also contain editable clustered column or line charts: at most two
per sheet and eight per file, one to three numeric series and 2–24 categories.
Each category/series is a vertical same-sheet A1 range; missing, nonnumeric or
unequal-length data fails before placement. Fixed DrawingML parts contain real
worksheet references plus verified caches, so Office can edit the source cells
and recalculate the chart. This follows the [Open XML drawing/chart relationship structure](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/how-to-insert-a-chart-into-a-spreadsheet).
`create-presentation` produces editable 16:9 PPTX with light/dark themes, up to
30 slides, short titles, optional paragraphs and real bullets. Dense slides are
rejected so authors split content instead of losing it. All three tools write a
temporary OOXML package, reopen it through the existing macro, embedding and
external-relationship validator, and only then place it at a new publication-safe
workspace path. `computer-artifact` remains a distinct, explicit publication step.

The conversation viewer extracts bounded Office content from the exact
receipt-verified published bytes: document paragraphs/tables, sheet grids with
cached formula values and preserved cell positions, and ordered slide text.
It accepts no HTML or external assets and does not claim Office layout fidelity.
Supported column/line charts are projected from the worksheet cells, never from
potentially stale chart caches. The chart/data view labels those values as cached;
it does not recalculate formulas. Unsupported chart types, axes, nonlocal ranges
or hidden rows/columns are omitted with the truncation notice. Narrow chart
regions scroll without shrinking their labels; exact values remain available in
keyboard-accessible data tables. Native generation and independent XLSX
open/edit/resave fixtures establish this bounded contract, not Excel rendering
or live provider acceptance.
Previews stop at 128 KB of text, 100 rows, 26 columns, eight sheets or 30 slides;
unsupported/oversized parts fall back to external opening. Save uses a native
file dialog rather than a model/renderer-selected host path, re-verifies the
receipt after selection, stages exact bytes and commits under the current
generation. Cancellation and revocation prevent placement, and existing files
are never overwritten. Open creates a fresh copy for normal Office editing.
Office publication also checks content XML, rejecting dynamic Word fields,
slide actions, external references and unknown/network-capable Excel functions.
Known local calculations remain supported. XML inspection has a 16 MB per-part
and one-million-node package budget. Non-XML parts must be verified raster
images; embedded fonts, binary printer settings and vector assets currently
require a passive export without those parts. This is deliberately a bounded
publication contract, not arbitrary Office-file compatibility.
PDF uploads retain exact original bytes in native custody, with the existing
scope, generation and receipt fences. `read-file` extracts up to 50 pages and
128 KB of untrusted text, and reports incomplete or truncated extraction;
scans and unsupported font encodings require visual inspection. PDFs pass the
same strict passive publication checks before upload/preview: no scripts,
interactive form actions, external links, encryption or embedded files.
The existing artifact and private-file previews render PDFs up to 8 MB with
PDF.js, page navigation, zoom and bounded page text. Renderer fonts and character
maps are packaged, with their notices; its asset factory accepts only exact
packaged names. No document URL is fetched and no annotation/form layer runs.
The lazy renderer has its own bundle chunk.

`create-pdf` uses the same shared tool registry, native exact-content approval,
staging, generation-fenced placement and no-overwrite path as Office authoring.
It creates passive A4 reports with headings, paragraphs, bullets, automatically
wrapped tables with repeated headers, page breaks and vector bar charts. Reports
are bounded to 200 blocks, 100 KB of text, 50 pages and 8 MB. A chart accepts up
to 20 label/value pairs, including negative and zero values. No code, arbitrary
font, remote asset, link or host application runs. Generated PDFs pass the same
passive validation before placement; `computer-artifact` explicitly publishes
the result for the existing page preview and Save/Open actions.

Fixed embedded Liberation Sans fonts provide measured widths and Unicode text
maps. Precomposed Latin, Greek and Cyrillic text supported by those fonts remains
selectable and readable. Missing glyphs, complex shaping/bidirectional scripts,
combining marks and overfull rows/charts are rejected with a clear alternative.
This report contract does not imply arbitrary PDF editing, OCR, layout fidelity
for existing documents, editable Office charts or a general code renderer.

`workspace-run` provides projectless code execution through the same Windows
WSL Ubuntu + Bubblewrap boundary as `repository-run`. The model selects up to
32 relative input files and 16 passive output paths, an exact bounded command,
network setting and 1–300 second timeout. This complete payload is approval
digest bound, scoped to the saved agent/workspace and current generation.
There is no host shell fallback or implicit network access. Network permission
includes LAN access and may have external effects; interrupted runs are never
automatically replayed.

Only selected inputs are copied into a private temporary `/repo`. Originals,
unselected workspace files, Windows mounts, user home and credentials remain
outside the sandbox. File analysis applies per-process 1 GB address-space,
300 CPU-second, 8 MB file and 128-descriptor limits; `/tmp` is 64 MB. This is
the existing local Linux execution boundary, not a dedicated virtual machine
or a guarantee against all resource exhaustion. Python3 and any used libraries
are prerequisites. Optional network-enabled installs can write only inside
the temporary environment; they cannot change `/usr` or the host runtime.

Only successful commands can produce outputs. Each declared output is reopened
with native handle/path validation, bounded to 8 MB (32 MB combined), checked
against the artifact passive subset and copied to private staging. PNGs are
fully decoded with the existing image bounds. Missing files, invalid formats,
links or credential markers reject delivery. One generation-fenced directory
rename imports the prepared set into a fresh `Generated/run-*` folder; Stop or
timeout imports nothing, and existing files are never overwritten. Receipts
include actual exit/interruption/output status and output path/size/SHA-256.
The existing `read-file`, artifact publication, preview and Save flows apply.

JSON outputs use the same immutable artifact receipt and native Save/Open flow.
Admission requires a complete valid JSON value within the existing file and
parser depth limits. The viewer displays at most 256 KB of literal UTF-8 text,
with an explicit truncation indicator; strings never become HTML or active links.
Saving retains the complete original bytes, including whitespace. An invalid
declared JSON output rejects the entire `workspace-run` output set before import.

Composer attachments also accept DOCX, XLSX and PPTX up to the existing 2 MB
upload limit. Original bytes are staged under the exact agent/workspace/generation
and are not decoded or imported as text knowledge. Invalid archives fail admission
before the agent runs. `read-file` extracts bounded Office content (up to 8 MB on
disk) through the shared native tool, including generated files, and the attachment
viewer uses the same content projection. ZIP entry, expansion, duplicate-name,
encryption, XML depth/node and output limits apply. Input is untrusted evidence;
no fields, macros, formulas, links or embedded programs execute. Cached sheet values
may be stale. The result states extraction limits and truncation; complete analysis
of a larger file requires smaller input or CSV. Agents can inspect supported input
and author a new revised Office deliverable, but original formatting, arbitrary
formulas and unknown structures are not preserved. Read-only extraction does not
grant permission to publish or externally open an active Office input; publication
retains the separate stricter passive-content gate.

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
