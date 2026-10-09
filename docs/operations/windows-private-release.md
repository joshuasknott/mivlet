# Windows private release operations

Mivlet's repository can build reproducible, unsigned Windows validation
artifacts. It cannot authorize signing, publication, a public updater channel,
or a release decision.

## Channels

The artifact manifest accepts only:

- `private` — Josh's own packaged testing;
- `internal` — a named internal validation group;
- `preview` — invited pre-release validation.

The generator rejects `public`. Every manifest says `signed: false`,
`publication: not-published`, and `updater: not-published`.

## Build and evidence

The manually dispatched `Windows private artifacts` workflow:

1. checks out one exact commit with the lockfile;
2. runs the complete repository and native gates;
3. builds unsigned MSI and NSIS installers with Tauri on Windows;
4. stages exactly one installer of each kind;
5. writes SHA-256 checksums, the source commit, commit timestamp, version,
   architecture, channel, and explicit unsigned/unpublished state to
   `release-manifest.json`;
6. generates matching private release notes;
7. uploads one short-lived GitHub Actions artifact without creating a release.

The manifest timestamp comes from the source commit, so the metadata and notes
are deterministic for identical artifact bytes. Installer bytes can still
include toolchain or Windows packaging metadata; byte-for-byte reproducibility
across runners is not yet claimed.

The normal Tauri build prepares Cua Driver 0.25.0 for Windows x64. Its archive
and executable hashes are pinned in `resources/cua-driver/runtime.json`; the
preparer also checks the publisher signature. Both installer formats must include
the executable, MIT license, transitive notices, inventory and MPL source archives.
See the [native computer architecture](../architecture/local-teammate-computer.md).
The installed capability has no Docker, Python, Node or separate Cua application
requirement. Build prerequisites and model-provider prerequisites are separate.
An extracted package proves resource inclusion; clean-machine launch and real
computer control are additional acceptance checks.

Local manifest tests:

```bash
pnpm release:test
```

## Candidate Node runtime backport

The production execution runtime remains the checksum-pinned official Node
22.23.3 archive. The isolated [candidate recipe](../../scripts/release/node-lpac/recipe.json)
backports only `src/win/pipe.c` from [libuv PR 5181](https://github.com/libuv/libuv/pull/5181),
commit `2cadaa40167050baf7c6905ac897e6fb57afb2c6`, into Node source commit
`80dc632040e6bada37aac1220dde9c79581c9c22`. It selects the `LOCAL` pipe namespace
when `TokenIsAppContainer` is true. The patch retains libuv's MIT notice.

As checked on 9 October 2026, official Node 22.23.3, 24.21.0 and 26.11.1 omit
this fix; libuv 1.53.0 includes it. Pinned libuv creates child stdio before
`CreateProcessW`, uses a non-LOCAL pipe name and indefinitely retries access
denial as a presumed name collision. This supports the observed synchronous
piped-child stall, but the failing Win32 error/stack has not been captured.
Microsoft documents the [AppContainer pipe namespace restriction](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea).
Source reasoning is not a native acceptance result.

The recipe verifies the official source/archive SHA-256, patch SHA-256, full
`pipe.c` preimage and full patched after-image. It refuses fuzzy patches. The
candidate retains every official Windows distribution file (including npm and
licences) except `node.exe`; packaging verifies this against the inventory taken
at preparation. It writes the source/recipe commits, toolchain observations,
build flags, per-file hashes, modification notice and unsigned/unpublished state.
The external `artifact-receipt.json` supplies the archive and executable hashes.
`process.versions.uv` remains 1.51.0; identify the backport by candidate ID and
hash, not the libuv version string. Toolchain versions are recorded, not supplied
by this recipe; byte-for-byte build reproducibility remains unproved.

Plan only (no download, preparation or compilation):

```powershell
pwsh -NoProfile -File scripts/release/node-lpac/build.ps1
```

After a separate native compilation grant, use an existing Windows x64 toolchain:
PowerShell 7.2+, Node 22+, full Python 3, NASM, Git, Windows `tar.exe`, and Visual
Studio 2022 17.6+ with C++ and Windows SDK. Follow the pinned
[Node build requirements](https://github.com/nodejs/node/blob/v22.23.3/BUILDING.md#windows).
Python's Windows Store alias is rejected. The recipe does not install tools,
change OS settings, grant capabilities, add firewall/loopback exemptions, or run
the upstream AppContainer harness. Do not disable OpenSSL assembly to evade the
NASM prerequisite. Commit the reviewed recipe first.

```powershell
# The existing writable parent must have no junctions; the leaf must not exist.
# Node requires a short ASCII build path without spaces, outside the checkout.
pwsh -NoProfile -File scripts/release/node-lpac/build.ps1 -Build `
  -Directory C:\MivletBuilds\node-lpac1-RECIPE_SHA `
  -Python C:\BuildTools\Python\python.exe `
  -Nasm C:\BuildTools\NASM\nasm.exe
```

Those paths are examples, not installed prerequisites. Queue approximately
20–30 GiB additional disk and 6–10 GiB peak committed memory, with at least
40 GiB free disk at admission; these are conservative estimates, not measured
results. Use one isolated source/output root. The driver uses
`vcbuild.bat x64 vs2022 ltcg nosign no-cctest`, BelowNormal priority and
process-local `NUMBER_OF_PROCESSORS=1` (upstream MSBuild `/m:1` and compiler
parallelism limit), with `/nr:false` to disable MSBuild node reuse. `vcbuild`
defaults to Release; `ltcg` enables release optimization. Its explicit `release`
argument also enables `cctest`, so this recipe uses the default Release mode to
build only the runtime. It strips unrelated inherited environment variables, prints
the owned compiler PID, saves stdout/stderr, and preserves failures for diagnosis.
Track and stop only that process tree if the coordinator's resource limits are
reached. No local compilation is implied by checking in or testing this recipe.

The resulting ZIP is a validation candidate only. It is not consumed by
`prepare-execution-runtime.mjs`, bundled by Tauri, or accepted by the native
runtime inventory. Before promotion:

1. Review the actual build log, selected compiler/SDK and artifact provenance;
   the manifest records the default MSVC and installed SDKs, not a claim about
   which SDK MSBuild selected. Verify the candidate hashes and retained licences.
2. In a granted, existing non-elevated LPAC setup, capture a bounded same-token
   current-versus-LOCAL Win32 pipe probe if direct causal evidence is needed.
   Preserve the production token, approvals, fences, Stop and no-network policy.
3. Prepare a separately reviewed candidate supplier/inventory update in an
   isolated worktree and rebuild the native consumer of that inventory. Hashes
   are embedded in Rust; substituting a binary alone must fail closed. Then run
   the piped-child/default `node --test`, npm lifecycle and exact descendant
   Stop/no-import acceptance against the candidate. Do not rerun unchanged failures.
4. Complete the relevant native and packaged-app gates before an explicitly
   authorized production promotion. Neither a host version smoke nor this
   recipe's tests proves LPAC, installed-app, provider or live capability.

The existing `network:false` development-server `listen EACCES` is a separate
policy/feature gap. A pipe namespace correction does not authorize a loopback
exemption or satisfy that positive server acceptance case.

## Disposable-machine installer rehearsal

On a clean Windows VM or CI runner:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release/test-windows-installer.ps1 `
  -InstallerPath .\Mivlet_0.1.0_x64-setup.exe `
  -AllowMachineChanges
```

The script refuses a machine that already has Mivlet or legacy Fable app data. It silently
installs the NSIS package, verifies Windows uninstall registration, rehearses a
second install, verifies a local-data sentinel survives, uninstalls, verifies
the sentinel still exists, then removes only its own test directory.

Pass `-PreviousInstallerPath` to turn the second install into a genuine
version-to-version upgrade rehearsal. A previous packaged version is not
invented by the repository, so that evidence remains open until one exists.

The workflow does not run or sign in to Mivlet. First launch, WebView behavior,
vault/keyring continuity, rollback to a previous build, and real data migration
still belong to the private packaged-app test matrix.

## Manual release gates

- select the intended channel and source commit;
- supply and custody Windows signing material;
- inspect signature and reputation behavior;
- run clean install, real previous-version upgrade, uninstall, rollback, and
  vault/data preservation on packaged builds;
- approve release notes and support contact;
- choose download hosting and updater endpoints;
- complete private soak and incident rehearsal;
- explicitly authorize any publication.


## Mivlet identity and existing installations

The app window, interface, native icons and release notes use Mivlet. The lowercase
mivlet wordmark is reserved for logo lockups; agents retain their own portraits.

Keep `com.fable.workspace`, credential namespaces, local storage keys, database
filenames, saved computer paths, and OAuth client configuration stable. Package
names are `@mivlet/*` and operator env keys are `MIVLET_*` (with a one-cycle
`FABLE_*` fallback). The pinned MSI upgrade code is the existing Fable code,
verified against the previously generated WiX manifest.

`tauri.conf.json` now uses productName and publisher Mivlet. The custom NSIS
template in `apps/desktop/src-tauri/windows/installer.nsi` retains the legacy
registry keys, reuses the registered install folder and migrates only shortcuts
targeting the installed executable. It is based on Tauri CLI 2.11.3's upstream
template, with its MIT license alongside. Review upstream changes on CLI upgrades.
The MSI upgrade code remains pinned. Never rename app-data or credential folders.

On 9 September 2026, both MSI and NSIS packages built successfully. NSIS updated
the existing Fable installation with exit code zero. The encrypted database and
WAL/SHM files were byte-identical immediately before and after installation.
The uninstall display name, publisher and Start Menu/desktop shortcuts now show
Mivlet. The installed executable launched with title Mivlet and responded. Its
bytes match the release binary except for Tauri's NSIS bundle marker. A local
backup was taken before installation. This verifies one real NSIS upgrade and
launch; MSI upgrade, uninstall/rollback and credential use remain untested.

GitHub is now `joshuasknott/mivlet`, with origin updated. Clerk branding, its
desktop OAuth display name, and Google consent name/logo were saved as Mivlet.
Client IDs, secrets, issuer URLs and redirect URIs were preserved. Google remains
in testing mode.

The local checkout is now `Projects/mivlet`, and its `origin` points to
`https://github.com/joshuasknott/mivlet.git`.

Convex copy changes typecheck locally, but no deployment target is configured.
Deploy through the existing account backend workflow when its target is available;
do not create a new backend merely for branding.

Historical documents and technical identifiers may still say Fable. They are not
a mandate to migrate existing user data.
