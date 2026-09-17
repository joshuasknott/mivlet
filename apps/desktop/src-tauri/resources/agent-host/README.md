# Embedded agent host

`pnpm --filter @mivlet/agent-host build` compiles the workspace source with Bun
1.3.3 into `mivlet-agent-host.exe` and records its SHA-256 in `runtime.json`.
Both generated files are excluded from Git. Tauri development and packaging
prepare them automatically. The native launcher checks the manifest and hash
before launch, and holds a Windows read lease against replacement while running.

OpenCode SDK/plugin are pinned to `0.0.0-dev-19449` (MIT). Bun 1.3.3 is MIT with
the linked-library terms described in `LICENSE-Bun.md`; upstream sources and
relinking instructions are included there. The complete Mivlet host source and
build command are in `packages/agent-host`. Build from source with a modified Bun
runtime to relink; no proprietary source is required.

The build also emits `THIRD_PARTY_NOTICES.txt` from the installed production
dependency graph. It includes the license texts shipped by those packages and
their metadata/source references. No provider credentials, chats or tool output
belong in this directory.
