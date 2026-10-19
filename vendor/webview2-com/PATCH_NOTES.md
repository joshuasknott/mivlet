# Mivlet patch notes

This directory vendors `webview2-com` 0.38.2 from the pinned crates.io source
used by Mivlet's Windows build. The package metadata, README, and MIT license
declaration are retained from upstream.

The local change is limited to `wait_with_pump`:

- waits on a completion event with COM-aware `CoWaitForMultipleHandles` slices;
- pumps and preserves `WM_QUIT` messages;
- reports channel disconnects and scoped timeouts;
- keeps the existing unbounded behavior unless a caller installs
  `scoped_wait_deadline` on the current thread.

The helper is intentionally scoped to the native startup caller by the Mivlet
integration. Cookie and other existing waits do not inherit a deadline.

The pinned upstream source hashes captured before patching are:

- `src/lib.rs`: `7B20702E9B5F31003F52B5C564D7786DD7B06536511E672586DE7CC6B06674BE`
- `Cargo.toml`: `D6AB33DE10D1A1F45DCB44CD7105456BE6D01D6BF10E54C360603F60315C5036`
