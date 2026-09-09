# Windows private release operations

Fable's repository can build reproducible, unsigned Windows validation
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

The bundled local-computer Dockerfile pins the verified Debian and Node base
image manifests by digest, and the desktop records a deterministic build-context
digest on both its owned image and containers. A missing, foreign, or stale label
causes a rebuild and replacement while the scoped persistent volumes remain in
place. Debian apt indexes and package versions still follow the current Bookworm
repositories; a release snapshot and package-lock policy is required before the
guest image itself can be claimed byte-for-byte reproducible.

Local manifest tests:

```bash
pnpm release:test
```

## Disposable-machine installer rehearsal

On a clean Windows VM or CI runner:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release/test-windows-installer.ps1 `
  -InstallerPath .\Fable_0.1.0_x64-setup.exe `
  -AllowMachineChanges
```

The script refuses a machine that already has Fable app data. It silently
installs the NSIS package, verifies Windows uninstall registration, rehearses a
second install, verifies a local-data sentinel survives, uninstalls, verifies
the sentinel still exists, then removes only its own test directory.

Pass `-PreviousInstallerPath` to turn the second install into a genuine
version-to-version upgrade rehearsal. A previous packaged version is not
invented by the repository, so that evidence remains open until one exists.

The workflow does not run or sign in to Fable. First launch, WebView behavior,
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
