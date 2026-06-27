# Release Notes

## Windows Preview Build

Command:

```bash
npm run tauri:build
```

Verified local artifacts:

- `apps/desktop/src-tauri/target/release/fable-desktop.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Fable_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Fable_0.1.0_x64-setup.exe`

## Distribution Gaps

- Code signing is not configured yet.
- Auto-update channels are not configured yet.
- macOS and Linux packaging are planned after the Windows preview path is stable.
