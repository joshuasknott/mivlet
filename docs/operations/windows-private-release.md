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
