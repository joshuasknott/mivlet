# Mivlet on Kubuntu 26.04 LTS

This source build targets Linux x86_64, including the ThinkCentre M80q Gen 3.
It remains pre-release software. Linux compilation, Linux package verification,
mock-provider tests and acceptance on the physical Kubuntu desktop are separate
checks. See the evidence section below before retiring the Windows installation.

## What moves to Linux

| Capability | Linux behavior |
| --- | --- |
| Account sign-in and encrypted workspace | Native Tauri/WebKitGTK app; requires configured account service and an unlocked Secret Service wallet. |
| Direct API providers | Bundled Linux OpenCode host, native credential custody and existing tool approvals. Gemini retains its native wire route. Each provider still needs a valid account/key and successful connection check. |
| Codex, Claude, Cursor, Grok, OpenCode | Install their official Linux CLI separately. Mivlet discovers the executable and validates the account; catalogue presence is not authentication. Reconnect on Linux. |
| Antigravity | Native installer uses the pinned official Linux x86_64 ACP 1.4.3 archive and checks archive/member hashes. Startup was tested without authentication; reconnect and validate a real request on the destination. |
| Files, knowledge, memory, passive document authoring, web fetch | Remain available through the existing scoped native tools. Local permissions and approvals still apply. |
| Remote/stdio MCP tools and connected apps | Existing native transport and OAuth boundaries. Reconnect credentials; install Linux executables for local MCP servers. |
| Open conversation links / verified passive artifacts | Human-initiated open in the default Linux application via `xdg-open`; existing scheme and artifact validation is retained. |
| Native desktop and owned-browser control | Unavailable. The Windows Cua driver, window identity hooks and browser ownership implementation are not a Linux backend. |
| Isolated command execution, persistent command jobs, live server previews | Unavailable. The Windows LPAC executor is not replaced with a host shell. Git/file operations do not establish isolated execution. |
| MCP Apps and custom HTML native guests | Unavailable where the Windows child-frame/network fences are required. Ordinary tool results and text remain readable. |
| Agent-requested protected secrets | Windows native capture only. The separate, human-initiated transfer dialog supports Linux through `kdialog` or `zenity`; no renderer secret-entry fallback. |
| Hosted browser/computer, phone and cloud tasks | Separate, deployment-gated services. This change neither deploys them nor proves live operation. |

These limitations mean a Windows workflow that requires native computer control
or isolated command execution still needs Windows for those steps.

## Install the development prerequisites

Run these in Konsole on Kubuntu, as your normal desktop user. Do not run Mivlet
or its package manager as root.

```bash
sudo apt update
sudo apt install --no-install-recommends \
  build-essential curl ca-certificates git file pkg-config \
  libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev patchelf \
  xdg-utils xdg-desktop-portal xdg-desktop-portal-kde kdialog
```

Install Node 22 or newer using your normal trusted Node installation method,
then install the pinned package manager:

```bash
node --version
npm install --global pnpm@10.34.7
```

Install stable Rust using the [official rustup instructions](https://rustup.rs/),
then open a fresh terminal or load its environment:

```bash
. "$HOME/.cargo/env"
rustc --version
cargo --version
```

The native library list follows [Tauri's Linux prerequisites](https://v2.tauri.app/start/prerequisites/).
The extra D-Bus development package supports native Secret Service access.

## Get the integrated source

```bash
git clone https://github.com/joshuasknott/mivlet.git
cd mivlet
git switch --track origin/codex/kubuntu-support-20261025
pnpm install --frozen-lockfile
pnpm linux:doctor
pnpm linux:doctor --desktop
```

The October 25 migration branches preserve independent unfinished/historical
work. They are not successive upgrades to merge together. This Linux branch
starts from integrated `main` commit `b36da26a` (PR #172); the preserved startup,
chat, right-navigation and older variants were inspected and left separate.
Do not copy Windows `node_modules`, Rust `target` directories, runtime caches,
virtual environments or executable profiles onto Linux.

The desktop check only probes the presence of the session wallet and portal;
it does not read credentials or prove that the wallet is unlocked. Enable KDE
Wallet / Secret Service in System Settings and unlock it when prompted. KDE's
[KWallet documentation](https://github.com/KDE/kwallet/blob/master/README.md)
describes its Secret Service backend. Keep one intended service owner; do not
install a competing wallet daemon merely to suppress a startup error.
Missing or locked secure storage must be fixed in the desktop session.

## Configure and run

Privately recreate `apps/desktop/.env.local` from its `.env.example`, using the
same account identity service as Windows. Preserve your real configuration
outside Git; do not paste its values into chat or build logs. The required public
Clerk issuer, OAuth client ID, audience and authorized party must match. Hosted
features also need the configured native Convex origin and renderer endpoint.
No cloud resource changes are needed for this local Linux build.

For local account entry, recreate `apps/accounts/.env.local` privately as well;
`tauri:dev` starts that account-entry application when configured. An existing
HTTPS account entry can be used with the corresponding configuration instead.
Do not enable mock authentication to make a real account workspace run.

```bash
pnpm --filter @mivlet/protocol build
pnpm --filter @mivlet/connectors build
pnpm tauri:dev
```

`pnpm dev` is a browser-only synthetic preview. It cannot demonstrate native
credential storage, provider authentication, persistence or Linux desktop
behavior. `pnpm tauri:dev` builds the native Linux provider host and starts the
actual app. Sign in, then reconnect a provider before opening the workspace.

For desktop launchers, user-installed CLI paths may differ from Konsole's PATH.
Install provider CLIs using their official Linux instructions, confirm each is
visible with `command -v`, and use the app's connection check. Never copy a
Windows provider profile to imply an authenticated Linux connection. Native
provider process supervision is cleanup, not a sandbox for arbitrary commands.

## Build and install a Debian package

Build on Kubuntu 26.04 for this machine. For wider distribution, use the oldest
intended supported distribution and test every target; glibc and WebKitGTK
compatibility do not follow from a successful build on a newer system.

```bash
pnpm tauri:build --bundles deb
find apps/desktop/src-tauri/target/release/bundle/deb -name '*.deb' -print
```

Inspect the exact package before installing it:

```bash
dpkg-deb --info apps/desktop/src-tauri/target/release/bundle/deb/*.deb
dpkg-deb --contents apps/desktop/src-tauri/target/release/bundle/deb/*.deb
sudo apt install ./apps/desktop/src-tauri/target/release/bundle/deb/*.deb
```

Use the single package just built if the directory contains more than one.
The Linux package must contain an ELF `mivlet-agent-host`, its integrity manifest
and redistribution notices, and must not contain `cua-driver.exe` or the Windows
execution runtime. These are unsigned developer packages, without an updater.
The [Tauri Debian packaging guide](https://v2.tauri.app/distribute/debian/)
describes system-library dependency handling. AppImage is not the acceptance
target of this change.

Public account configuration is embedded by the build wrapper; credentials
must remain in native secure storage. A package built without valid account
configuration correctly asks for configuration rather than entering a fixture.

## Wayland and X11

[Kubuntu 26.04's release notes](https://kubuntu.org/news/kubuntu-26-04-release-notes/)
identify Plasma Wayland as the default supported session. Its optional X11
session is not supported by Kubuntu. Use Wayland for the normal setup and
record the actual session with `echo "$XDG_SESSION_TYPE"` during acceptance.

Wayland intentionally prevents a normal client from inspecting or controlling
arbitrary other windows. [RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
and [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
portals offer user-mediated capabilities, but are not equivalents of Mivlet's
Windows exact-window identity, background input, physical-input takeover and
Stop hooks. No portal desktop-control backend is shipped here. Running via
XWayland or selecting X11 does not enable those missing capabilities.

For a blank window, first capture the WebKitGTK/Mesa versions and consult
[Tauri's Linux graphics guidance](https://v2.tauri.app/develop/debug/linux-graphics/).
Do not set `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS`, run as root, or disable
Mivlet navigation/network checks. A graphics workaround must be evaluated on the
actual machine and is not a default installation step.

## Migration and final acceptance

Keep the Windows laptop and its original user account intact until the transfer
and native checks below have passed. A raw copy of
`AppData/Roaming/com.fable.workspace` is recovery material, not a portable
workspace: its database is encrypted with a Windows credential-store key.
Existing SQLite backups still require that matching OS key.

Never copy Windows credential-store files, deployment secrets, or provider
tokens into the Linux workspace. Copy project source by cloning GitHub and
reinstalling dependencies. Transfer Mivlet's private history separately using
the native workflow below; GitHub does not contain your local conversations.

### Transfer Windows history safely

1. Keep the original Windows account and data intact. Stop active turns and the
   background worker. Create a normal encrypted recovery backup on Windows as
   an additional rollback copy; it still requires the original OS vault key.
2. Run this branch's native Windows app with your existing account configuration
   and sign in to the original Mivlet account. Use a separate checkout for this
   branch if your current checkout contains unfinished work. The feature must
   exist in the Windows exporter as well as the Linux importer.
3. Open **Settings → General → Move to another computer**, expand
   **Export encrypted portable history**, and choose **Export portable history**.
   Select a new filename, confirm the sensitive
   content notice, and enter a strong, unique passphrase in the native dialog.
   The file is never overwritten automatically. Keep the passphrase separately
   from the file; it cannot be recovered from Mivlet.
4. Copy the encrypted transfer file to the ThinkCentre using your chosen private
   file-transfer method. Keep the Windows source until validation is complete.
5. On a fresh Linux installation, sign in to the **same Mivlet account**. Before
   connecting a provider, expand **Move history from another computer** and
   choose **Import portable history**. Select the file and enter the passphrase
   in the native KDE dialog. The account's destination must be empty apart from
   first-launch defaults; import never merges or replaces an existing workspace.
6. A successful import commits all rows together, freezes stale writes, closes
   the account session, and restarts Mivlet. Reconnect providers and connectors.
   Permissions start at Read Only; grant fresh approvals for subsequent work.
7. Compare important conversations, branches, agents and memory with Windows.
   Reimport required local files and rebuild machine-specific configuration.
   Keep both source and encrypted transfer until you have used the Linux app
   successfully and confirmed persistence after restarting.

The transfer supports the default local workspace: private, non-project
conversation messages and their revisions, agent configuration, selected memory
and knowledge metadata. It excludes project-owned rooms and collaboration
records, output/attachment file bytes, repository bindings and absolute-path
metadata, provider sessions/credentials, approvals, running work, schedules,
cloud links, caches and browser profiles. User-written chat, instructions and
memory can themselves contain sensitive text; encryption does not redact that
content. This is a bounded history transfer, not a complete machine image.

The versioned envelope uses AES-256-GCM with a random salt/nonce and
PBKDF2-HMAC-SHA256 at 600,000 iterations. The passphrase stays in native memory;
the decrypted payload is re-encrypted with the destination's own OS vault key.
Passphrases must contain 12–512 characters; plaintext is limited to 256 MiB.
Wrong passphrase, tampered data, unsupported format, wrong account or a
nonempty destination fails without replacing the destination data.

### Resume on the ThinkCentre

The GitHub branch is the installation handoff. Once Kubuntu is set up, follow
the clone/prerequisite commands above. Run `hostname -I` and
`systemctl is-active ssh` only if remote assistance is wanted; an SSH server is
not required to clone, build or run Mivlet locally.

On the actual ThinkCentre, verify all of the following before treating the
Linux machine as your primary Mivlet device:

1. Launch the installed package from Plasma Wayland and authenticate to the
   real account; test sign-out and return without mixing account workspaces.
2. Reconnect each required provider. Send a small ordinary request, exercise
   an allowed file/web tool, deny an approval, approve an exact action, and
   Stop a turn. Reopen the app and confirm history and credentials persist.
3. Verify imported conversations, branches and agent configuration against
   Windows; confirm excluded local files are separately available where needed.
4. Confirm desktop/browser control and isolated commands show their Linux
   prerequisite and cannot proceed through an approval or shell fallback.
5. Open a web link and a validated passive document; test file dialogs,
   notifications, display scaling, keyboard focus and the window controls.
6. Test any required dictation/device permission and connected MCP/OAuth flow
   with its actual service. Mock-provider acceptance does not cover these.

Being on the same Wi-Fi does not establish remote access. No ThinkCentre SSH
connection was configured or assumed by this implementation.

## Verification evidence and checkpoint

The October 25 checkpoint was exercised in Ubuntu 26.04.1 x86_64 under WSL,
using Node 22.23.2, pnpm 10.34.7 and stable Rust 1.99.1. This is a Linux build
environment, not the physical ThinkCentre or a Plasma/KWallet session.

Completed checks include frozen dependency installation, the Linux prerequisite
doctor and its tests, public-build-environment and CI-routing tests, repository
TypeScript checks, repository quality checks, 43 focused desktop tests, and the
actual bundled Linux host suite (76 passed, three expected skips). A hostile
working-directory fixture verifies that the compiled host does not load ambient
dotenv files or Bun preload configuration. Responsive transfer UI checks used
the actual components in a browser; native dialogs were not exercised there.

Native formatting and Clippy passed (Linux excludes dead-code warnings for
shared Windows implementation bodies; Windows CI keeps its strict gate).
The complete native suite passed: 1,162 tests, with 12 opt-in/platform tests
ignored. This includes transfer encryption, account binding, atomic import,
destination-vault re-encryption, stale-writer rejection, and Unix lock handoff.

`pnpm tauri:build --debug --bundles deb` produced an amd64 Debian package.
Inspection confirmed the desktop ELF, Linux baseline provider host, executable
PTY sidecar, matching integrity hashes and third-party notices, with no Windows
executable included. The extracted package created its window and finished
loading its bundled page under an isolated Xvfb/D-Bus session with a fresh
profile. This startup smoke check did not authenticate an account or provider.

One release gate remains open at this checkpoint: `pnpm perf:check` reports
386,170 gzip bytes for common JavaScript/CSS against its 385,024-byte ceiling
(1,146 bytes over). The existing budget is unchanged. The production frontend
and Debian build succeed; the draft needs this small bundle regression resolved
before release readiness is claimed.

The native Secret Service acceptance test wrote, reopened, read and deleted one
synthetic credential using a disposable, isolated service. That establishes the
Linux keyring integration in this environment, not KWallet acceptance on the
destination. The pinned Antigravity Linux archive/member hashes and an
unauthenticated ACP initialization were checked; no paid provider request was
made.

Keep the GitHub pull request as a draft until the physical acceptance steps
above pass. Real account/provider authentication, KWallet unlock and persistence,
native Windows-to-Kubuntu transfer dialogs, Plasma graphics and device/OAuth
flows remain destination-machine checks. Preserve the Windows installation and
its recovery material while completing them.
