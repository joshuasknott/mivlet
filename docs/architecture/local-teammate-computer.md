# Local teammate computer

> **Status: implemented local foundation.** Fable creates a separate Linux
> container desktop for each workspace/teammate pair. This is a genuine
> operating-system userspace, but it is a Docker container inside Docker
> Desktop's Linux environment, not a separate virtual machine per teammate.

## Experience

The computer presents one compact desktop with Chromium, Files, and Terminal.
Fable can show an ephemeral screen, launch those applications, and let the
person take control for a human-only step. The control lease expires after five
minutes unless returned sooner. Every takeover, return, restart, and frame is
generation-fenced so stale input cannot cross a control transition.

The app exposes a bounded relative file list and an ephemeral UTF-8 text preview
for the teammate workspace. It never returns the host path, Docker resource
name, browser-debug endpoint, cookie store, or process handle to React or the
model.

## Storage and lifecycle

Each opaque workspace/teammate scope owns:

- a Docker volume mounted at `/home/fable`, preserving the Linux home,
  applications' settings, downloads, and Chromium profile across container
  replacement;
- one Fable-owned host directory mounted at `/home/fable/Workspace`, providing
  the narrow file bridge used by approved file tools and the trusted UI; and
- one labelled container whose ownership and scope labels must match before
  Fable reuses, starts, stops, or replaces it.

The first setup builds the bundled `fable-local-computer` image. Setup fails
closed if Docker Desktop's WSL 2 Linux engine is unavailable or the bundled
image context is missing. A newer image replaces the old container while
retaining the labelled home volume and scoped workspace.

The container may remain alive independently of the window, but Fable does not
claim that an ordinary conversation continues after the desktop process closes.

## Tool boundary

- `read-file` and `write-file` are confined to the exact teammate workspace.
  Absolute paths, traversal, links, junctions, and canonical escapes fail.
- `run-shell` executes as the unprivileged `fable` user in
  `/home/fable/Workspace`, with a 60-second timeout and bounded output. It never
  falls back to Command Prompt, PowerShell, or another host shell.
- `local-browser` accepts a credential-free HTTP(S) URL under exact approval.
  The model receives only bounded title/origin metadata.
- Browser observation exposes at most 40 visible named non-secret controls.
  Exact single-use references support the approved click, fill, selection, or
  allowlisted key action. Secret-shaped fields, body dumps, screenshots,
  cookies, and hidden state are not returned to the model.
- All agent browser actions fail while the person holds control.

Website sign-in happens inside the container browser. Fable does not scrape its
cookies or translate that browser session into an application credential.

## Isolation controls

The container is limited to two CPUs, 2 GiB memory plus 1 GiB additional swap,
512 processes, and bounded shared-memory and temporary filesystems. Docker
publishes the Chromium bridge on a random loopback-only host port. Fable invokes
Docker with argument arrays rather than a host shell, validates labelled
resources before reuse, and keeps resource identifiers native.

The image runs the desktop and ordinary commands as UID 1000. It drops all
container capabilities, then adds only the capabilities Debian Chromium's SUID
sandbox needs to establish and drop its renderer isolation. Chromium runs with
its sandbox enabled; renderer smoke evidence verifies an unprivileged user, no
effective capabilities, `NoNewPrivs`, and seccomp filtering.

## Limits

- Containers share the Docker Linux kernel and Docker daemon trust boundary.
  This is materially separate from the user's Windows desktop but weaker than a
  dedicated virtual machine or remote hardware boundary.
- Default Docker networking remains available. The current implementation does
  not yet provide per-teammate egress allowlists, DNS policy, or network
  accounting.
- The scoped workspace is an intentional host bind mount. A vulnerability in an
  approved container process could affect files inside that scope, though not
  arbitrary host paths through Fable's interface.
- Package updates, image signing, vulnerability response, resource telemetry,
  container reset/export, and public installer validation remain incomplete.
- Browser control is deliberately bounded: no arbitrary selector/script
  channel, clipboard access, secure secret injection, multi-tab control, or
  general desktop vision is claimed.

## Verification

Portable tests cover scope derivation, resource naming, Docker argument
construction, path confinement, file projection, URL policy, generation fences,
and exact control references. Live tests require Docker and exercise image
build, container startup, persistence across replacement, Chromium sandboxing,
screen capture, terminal execution, browser navigation, and human-control
fencing. Those tests prove the local machine under test only.
