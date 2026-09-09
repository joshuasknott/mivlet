# Local teammate computer

> **Status: implemented local foundation.** Mivlet creates a separate Linux
> container desktop for each workspace/teammate pair. This is a genuine
> operating-system userspace, but it is a Docker container inside Docker
> Desktop's Linux environment, not a separate virtual machine per teammate.

## Experience

The computer presents one compact desktop with Chromium, Files, and Terminal.
Mivlet can show an ephemeral screen, launch those applications, and let the
person take control for a human-only step. An inactive human lease expires after
five minutes into an explicit paused state. Closing or disconnecting the viewer
never returns control to the agent. Native authority is persisted independently
from Chromium; process restart and browser reconnection require an explicit
resume. Every takeover, return, restart, and frame checks its generation.

The app exposes a bounded relative file list and an ephemeral UTF-8 text preview
for the teammate workspace. It never returns the host path, Docker resource
name, browser-debug endpoint, cookie store, or process handle to React or the
model.

Conversation artifact previews read the immutable published copy through the
same encrypted receipt, digest, workspace/agent and generation checks as opening
a file. The main window receives at most 256 KB of UTF-8 text or an 8 MB raster
image as an ephemeral preview. Office files and larger images retain the verified
open-copy action. Previewing never navigates to a model-provided local path or
renders executable HTML. Narrow layouts use a focus-trapped preview dialog.

## Storage and lifecycle

Each opaque workspace/teammate scope owns:

- a Docker volume mounted at `/home/fable`, preserving the Linux home,
  applications' settings, downloads, and Chromium profile across container
  replacement;
- a separate labelled volume at `/home/agent` for the unprivileged agent's
  terminal home and tool configuration;
- one Mivlet-owned host directory mounted at `/home/fable/Workspace`, providing
  the narrow file bridge used by approved file tools and the trusted UI; and
- one labelled container whose ownership and scope labels must match before
  Mivlet reuses, starts, stops, or replaces it.

The first setup builds the bundled `fable-local-computer` image. Setup fails
closed if Docker Desktop's WSL 2 Linux engine is unavailable or the bundled
image context is missing. The expected image tag, actual image ID, and runtime
configuration version are checked at startup. A mismatch replaces the system
container while retaining both labelled home volumes and the scoped workspace.

Computer options exposes Stop, Restart, and Update system. Each action revokes
authority immediately, cancels agent processes, drains admitted operations, and
invalidates the browser connection before changing the container. Restart and
update finish paused and require an explicit choice of who continues. Save open
work first: saved files persist, but stopping applications can lose unsaved work.

At most two Mivlet computers may run or sleep at once; sleeping computers still
reserve their memory slot. Start admission is serialized across computers. The
Docker restart policy is `no`, so an engine restart does not silently start all
agent desktops. Existing containers receive the same policy when started.

While Mivlet is running, a computer with no admitted operation and no active
viewer sleeps after 30 minutes of inactivity. Idle checks and viewer/operation
admission share the native authority lock. Sleep uses Docker pause to freeze
CPU activity while preserving application memory; it keeps its RAM allocation.
Starting the computer unpauses it with control remaining explicitly paused.
The native monitor stops with Mivlet and does not promise work after app exit.
These semantics follow Docker's [pause](https://docs.docker.com/reference/cli/docker/container/pause/)
and [restart policy](https://docs.docker.com/engine/containers/start-containers-automatically/) contracts.

Closing Mivlet's main window immediately removes viewer capabilities and blocks
new computer and provider work. Native shutdown revokes every known computer,
drains admitted actions, cancels supervised commands and pending downloads, and
stops retained provider processes before exiting. The Linux container and saved
state may remain alive; ordinary conversations do not continue after app exit.

## Generated artifacts

The explicit `computer-artifact` tool publishes one generated Workspace file
under an exact approval and the current agent-control generation. It accepts
PDF, DOCX, XLSX, PPTX, CSV, TXT, Markdown, PNG, JPEG, GIF, and WebP files of at
most 25 MiB. Relative paths, opened file handles, size, and type signatures are
checked; links, hidden path components, host paths, executables, HTML, SVG,
macro-enabled Office files, embedded Office programs, and external Office
relationships are rejected. Office packages must contain the matching standard
main part, content type, and root relationship metadata.

PDFs pass a strict parser-backed structural validator before publication and
again before opening. The accepted subset has one PDF header and final marker,
at least one page, bounded object, page, node, and stream expansion counts, and
no encryption, forms, scripts, actions, external streams, multimedia, or
embedded files. The validator parses indirect and compressed object-stream
objects rather than relying on byte-pattern removal. It rejects unsafe input; it
does not rewrite or claim to sanitize a document.

The guest exposes PptxGenJS 4.0.1 through `NODE_PATH` for editable slide
generation, LibreOffice Impress for presentation editing and PDF conversion,
and Poppler command-line tools for PDF inspection and page rendering. The image
build generates all four document formats, renders the document and
presentation PDFs, and verifies LibreOffice's cached spreadsheet recalculation.

Publication copies the bytes outside the guest mount. An opaque ID and
credential-free metadata return in the tool result, which persists with the
conversation. The existing encrypted private-workspace document store holds
the authenticated scope and digest receipt; retired artifact tables are not
reintroduced. The main Mivlet window can open the receipt only for its saved
agent and a current generation. Native code verifies the immutable published
copy against its receipt, then opens a fresh copy through Windows' registered
file application. Edits to that opened copy do not alter the published version.
No host path, file contents, or native digest enter the conversation receipt.
Publication and open-copy folders each allow at most 256 files per computer.

## Tool boundary

- `read-file` and `write-file` are confined to the exact teammate workspace.
  Absolute paths, traversal, links, junctions, and canonical escapes fail.
- `run-shell` executes as the unprivileged `agent` user (UID 1001) in
  `/home/fable/Workspace`, with a 60-second timeout and bounded output. It never
  falls back to Command Prompt, PowerShell, or another host shell.
- `local-browser` accepts a credential-free HTTP(S) URL under exact approval.
  The model receives only bounded title/origin metadata.
- `local-browser-observe` returns bounded visible page text, at most 40 named
  controls, and up to 16 tabs. Input values, editable text, hidden content, and
  credential-shaped containers are excluded. References bind the current
  generation and observation; mutations consume the observation once.
- `local-browser-action` supports exact referenced click, fill, selection,
  allowlisted keys, and file upload. Uploads read at most 25 MiB from a verified
  opened Workspace file, then stage an immutable guest copy inaccessible to
  agent processes before binding it to the observed file input.
- `local-browser-tab` opens normalized HTTP(S) URLs or switches/closes an exact
  observed tab. Downloads use the shared Workspace/Downloads directory.
- `local-desktop-observe` and `local-desktop-action` support native screenshots
  and bounded pointer, drag, scroll, text, and keyboard input. Observations
  expire after 30 seconds, are single-use, and bind pixel dimensions. A resized
  desktop requires a new observation. Private browser surfaces, visible secret
  fields, and credential-shaped text input fail closed for human completion.
- Desktop images are available only to Codex models whose live model catalog
  advertises image input. Native code binds pixels to the exact pending provider
  call, arguments, approved scope, generation, and response. JPEG bytes stay in
  native memory until a checked image response goes directly to the ephemeral
  provider session. React and Mivlet's saved transcript receive metadata only.
  Other providers retain structured browser, terminal, and file tools.
- Every computer tool requires an exact, single-use persisted approval with
  workspace, agent, and generation binding. Agent observation, files, terminal,
  browser, and desktop operations share native admission tickets. Takeover
  revokes tickets immediately, cancels guest agent processes, and drains old
  operations before enabling human input. Late results are discarded. A drain
  timeout leaves control paused with an explicit retry.

Website sign-in happens inside the container browser. Mivlet does not scrape its
cookies or translate that browser session into an application credential.
Before model image capture, native checks inspect visible X11 window metadata
and AT-SPI password/modal roles without reading text values. Unknown browser
dialogs and browser-owned file choosers require human control; approved
structured uploads retain their Workspace confinement. The checks use the
standard [AT-SPI roles](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/enum.Role.html)
and [X11 modal window properties](https://apol.pages.freedesktop.org/xdg-specs/wm-spec/latest/ar01s05.html).

## Isolation controls

The container is limited to two CPUs, 2 GiB memory plus 1 GiB additional swap,
512 processes, and bounded shared-memory and temporary filesystems. Docker
publishes a native-authenticated gateway on a random loopback-only host port. Mivlet invokes
Docker with argument arrays rather than a host shell, validates labelled
resources before reuse, and keeps resource identifiers native.

Root initializes service state and supervises the gateway. Chromium and the
window manager use UID 1000. Approved commands use UID 1001, with an empty
capability bounding set, `NoNewPrivs`, and no X or browser credentials. Files,
Writer, spreadsheets, and the terminal display use UID 1002 with the same
privilege drop and a separate application home. Root initialization refuses
symlinked directories before changing ownership or permissions.

The fixed native GUI launcher requires [Landlock ABI 6 or newer](https://docs.kernel.org/userspace-api/landlock.html)
and fails closed when unavailable. It allows application files, Workspace, and
required system runtime files while denying the browser profile and private
service state. X authenticates GUI applications through the Unix socket peer's
UID using `SI:localuser:apps`; those applications receive no copyable X cookie.
A root-owned preload installs an additional deny-all-execution
Landlock rule and seccomp filter before application code runs. This blocks Open
With shell commands, custom executables, direct dynamic-loader invocation, and
memory-file execution. Writable home, Workspace, and temporary mounts are
`noexec,nosuid,nodev`; the app sandbox denies TCP and scopes signals. The XFCE
panel and desktop launchers are replaced by Mivlet's fixed application buttons.

Terminal uses a root-created PTY: its closed-execution xterm display is UID 1002
and its interactive shell is UID 1001. The narrowly allowed root launcher accepts
no arguments and acknowledges only after the display guard and shell privilege
checks succeed. Its supervisor shares the shell operation lock, rejects queued
concurrent commands, and kills UID 1001 descendants including detached sessions
on completion or cancellation. The GUI applications retain unsaved documents
through takeover; Mivlet drains their admitted native input and launch operations.

Chromium uses anonymous debugging pipes. There is no TCP CDP listener; the
native-only gateway translates its authenticated WebSocket to those pipes.
The root service's random credential stays in native memory and a private guest
directory, outside the renderer and model. Human viewing uses a distinct,
ephemeral native capability. Browser uploads are copied from verified artifact
bytes into root-owned staging readable by Chromium and inaccessible to UID 1001,
preventing a later Workspace symlink swap from changing the upload. Staging
limits are 32 MiB per file, 128 MiB total, and one-hour expiry. Browser downloads
first enter a private UID 1000 directory under GUID filenames. The root gateway
publishes completed files up to 25 MiB into `Workspace/Downloads` using held
directory handles, refusing symlinks and overwrites. A replaced Downloads link
therefore cannot redirect Chromium writes into its profile. Safe completion or
failure status is available through structured browser observations. Revocation
cancels active downloads and drains publication already in progress.

The container drops capabilities by default and adds the bounded capabilities
needed by Chromium's SUID sandbox and root initialization/process cancellation.
Chromium keeps its sandbox enabled and its built-in password manager disabled.
LibreOffice macro execution and extension installation/removal are disabled by
finalized system policy. Native admission prevents new Mivlet-issued input after
revocation; ordinary page scripts and existing trusted GUI behavior can continue.
This is a layered desktop boundary, not a claim that third-party GUI applications
or the shared X server are free from exploitable vulnerabilities.

## Limits

- Containers share the Docker Linux kernel and Docker daemon trust boundary.
  This is materially separate from the user's Windows desktop but weaker than a
  dedicated virtual machine or remote hardware boundary.
- Default Docker networking remains available. The current implementation does
  not yet provide per-teammate egress allowlists, DNS policy, or network
  accounting.
- The scoped workspace is an intentional host bind mount. A vulnerability in an
  approved container process could affect files inside that scope, though not
  arbitrary host paths through Mivlet's interface.
- Package updates, image signing, vulnerability response, resource telemetry,
  container reset/export, and public installer validation remain incomplete.
- Tools expose no arbitrary selector/script channel, host clipboard, or secure
  secret injection. Structured text and screenshots are untrusted evidence;
  private sign-in requires human control. Visual image delivery currently uses
  the Codex adapter; other provider image bridges are not implemented.

## Verification

Portable tests cover scope derivation, resource naming, Docker argument
construction, path confinement, file projection, URL policy, generation fences,
and exact control references. Live tests require Docker and exercise image
build, container startup, persistence across replacement, Chromium sandboxing,
screen capture, terminal execution, browser navigation, and human-control
fencing. Those tests prove the local machine under test only.

## Component selection and stream transport

The September 2026 review compared the actual Mivlet container boundary with
three maintained upstream projects:

| Component | Verified upstream | Decision |
| --- | --- | --- |
| KasmVNC | [1.5.0 release](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0), July 29, 2026; GPL-2.0 server and MPL-2.0 noVNC-derived client | Use its desktop streaming server and a small decoder bundle, behind Mivlet's authority boundary. |
| Cua | [Current Rust driver source](https://github.com/trycua/cua/tree/5cd40c1d0222bc378635f6f65444cf3ececf7979/libs/cua-driver) and [Python server package](https://github.com/trycua/cua/blob/5cd40c1d0222bc378635f6f65444cf3ececf7979/libs/python/computer-server/pyproject.toml); MIT project, Rust driver 0.23.2 and Python computer-server 0.3.45 | Retain Mivlet's native tools. Cua's newer Rust driver provides a possible later accessibility integration, but importing its complete server adds another session, tool, and policy boundary. |
| Browser Use | [0.13.10 release](https://github.com/browser-use/browser-use/releases/tag/0.13.10), September 4, 2026; MIT, Python 3.11+ | Keep Mivlet's native CDP implementation. Its [Actor API](https://github.com/browser-use/browser-use/blob/0.13.10/browser_use/actor/README.md) can attach without its Agent runtime, but importing the full package adds provider SDKs, telemetry configuration, and a Python dependency graph for capabilities already reachable through CDP. |

Cua's Python server requires Python 3.12–3.13, while the Debian image uses 3.11.
Its [Linux Python accessibility handler](https://github.com/trycua/cua/blob/5cd40c1d0222bc378635f6f65444cf3ececf7979/libs/python/computer-server/computer_server/handlers/linux.py)
contains simulated accessibility data; the newer Rust driver has real
AT-SPI/X11/Wayland support, so those are distinct integration candidates.
Mivlet does not install a second autonomous agent loop from either project.

KasmVNC 1.5 adds H.264/H.265/AV1 video support through browser WebCodecs. The
actual encoding depends on browser/host capabilities; rectangle decoding remains
available when those codecs are unavailable. The image limits streaming to 30
frames per second. It pins the Debian bookworm amd64 release package by SHA-256
`770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71` and builds
the matching [client commit](https://github.com/kasmtech/noVNC/tree/475ecfa5356579ef222983c7ce4619a7576a3bce)
from an archive pinned to
`325084abe7af9174812f06933a9f154d044b485254eda9f49ce511552a262420`.
This is KasmVNC's client protocol, rather than an interchangeable stock noVNC
package. The decoder adapter uses the source's six-argument RFB constructor,
removes its own input listeners, disables automatic session resizing and WebRTC,
and retains Mivlet's viewer UI. Upstream client source, build adapter, MPL license,
and pako license are included in the image. The server remains GPL software;
the separate MIT-licensed Cua integration named Kasm does not relicense it.

The [server configuration](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/unix/kasmvnc_defaults.yaml)
disables pointer, keyboard, clipboard, and client setting overrides. Its account
has read permission only. Kasm's local WebSocket still requires HTTP Basic
authentication; the gateway supplies a private read-only credential and the
[required Origin header](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/common/network/websocket.c).
Legacy RFB authentication is disabled only inside that authenticated transport,
and direct RFB ports are disabled. Human input travels through a separately
authenticated typed native operation, never through the viewing stream.

Live guest protocol probes verified private Chromium CDP, blocked unauthenticated
gateway access, absence of listeners on 5900/5901/9222, read-only rejection of raw
RFB pointer input, and approved pointer movement. Thirty guest-local input calls
measured roughly 32 ms median and 40 ms p95 on the development machine; this is
transport/helper evidence, not an end-to-end visual latency guarantee. A clean
idle desktop used about 426 MiB in one sample. Native UI and release verification
must assess the complete frame-to-input experience separately.
