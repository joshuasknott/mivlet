# Mivlet patch notes

This directory vendors `webview2-com` 0.38.2 from the pinned crates.io source
used by Mivlet's Windows build. The README and source files are retained from
upstream, except the changes below. The MIT license is copied from upstream
revision `b74dc5e2b394044bea5191052868ce7a106c202c`.

The local code change is limited to `wait_with_pump`, its scoped deadline and tests:

- polls the receiver between COM-aware `CoWaitForMultipleHandles` slices;
- pumps and preserves `WM_QUIT` messages;
- reports channel disconnects and scoped timeouts;
- keeps the existing unbounded behavior unless a caller installs
  `scoped_wait_deadline` on the current thread.

The helper is intentionally scoped to the native startup caller by the Mivlet
integration. Cookie and other existing waits do not inherit a deadline.

Cargo metadata enables the Windows threading/security APIs needed for the
wait-owned event and removes the unused sample example declaration. The event
stays unsignaled; 50 ms COM-aware waits allow completion callbacks to run while
keeping apartment-bound results on their owning thread. At most 64 queued
window messages are drained per slice, so a message flood cannot indefinitely
prevent the next deadline check.

References: [upstream source](https://github.com/wravery/webview2-rs/tree/b74dc5e2b394044bea5191052868ce7a106c202c),
[COM wait semantics](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-cowaitformultiplehandles).
The related [Wry issue](https://github.com/tauri-apps/wry/issues/1665) is supporting
context, not proof of the cause of Mivlet's observed x64 startup failures.

`Cargo.lock` pins the standalone regression-test build using versions from the
desktop lockfile. Production resolution remains in the desktop's `Cargo.lock`.
Run `cargo test --manifest-path vendor/webview2-com/Cargo.toml --lib --locked`
on Windows when updating this patch.

The pinned upstream source hashes captured before patching are:

- `src/lib.rs`: `7B20702E9B5F31003F52B5C564D7786DD7B06536511E672586DE7CC6B06674BE`
- `Cargo.toml`: `D6AB33DE10D1A1F45DCB44CD7105456BE6D01D6BF10E54C360603F60315C5036`
