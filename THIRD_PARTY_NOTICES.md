# Third-party notices

Mivlet's original source is licensed under the root MIT license. Separately
licensed dependencies and third-party assets retain their own terms; the root
license does not relicense them or grant rights to third-party trademarks.

- Cua Driver 0.25.0: MIT; see
  `apps/desktop/src-tauri/resources/cua-driver/LICENSE-CUA.txt`. Its pinned
  dependency notices, Inter OFL, and MPL source archives are in that directory.
- Embedded OpenCode: MIT; see
  `apps/desktop/src-tauri/resources/agent-host/LICENSE-OpenCode.txt`.
- Bun: MIT with separately licensed components including LGPL JavaScriptCore;
  see `apps/desktop/src-tauri/resources/agent-host/LICENSE-Bun.md` for upstream
  source and rebuilding instructions. The host build generates
  `THIRD_PARTY_NOTICES.txt` from the installed dependency graph. Preserve these
  notices and applicable source/relinking materials when distributing binaries.
- Inter fonts: SIL Open Font License 1.1, supplied by `@fontsource/inter`.
- Phosphor icons: MIT, supplied by `@phosphor-icons/react`.
- Connector logos: Simple Icons CC0 and separately sourced provider marks;
  see `apps/desktop/src/assets/connectors/README.md` and its `LICENSE.md`.
  Provider names and logos identify integrations and imply no endorsement.
- Tauri installer template: its MIT notice is preserved in
  `apps/desktop/src-tauri/windows/LICENSE-MIT`.

Package-manager dependencies are pinned in `pnpm-lock.yaml` and
`apps/desktop/src-tauri/Cargo.lock`. Consult each dependency's included license
before redistribution. Public source availability is not a signed binary release.
