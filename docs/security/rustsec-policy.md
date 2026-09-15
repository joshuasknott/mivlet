# RustSec policy

`pnpm audit:cargo` runs `cargo audit` against the desktop lockfile. New
vulnerability findings fail the gate.

## Temporary notification-only exception

The lockfile currently contains `quick-xml` 0.37.5 only through:

```text
mivlet-desktop
  -> tauri-plugin-notification
  -> notify-rust
  -> tauri-winrt-notification 0.7.2
  -> quick-xml 0.37.5
```

This produces `RUSTSEC-2026-0194` and `RUSTSEC-2026-0195`. The affected APIs
parse attributes and namespaces through `Reader`, `NsReader`,
`NamespaceResolver`, attribute iteration, or `try_get_attribute`.

The checked source for `tauri-winrt-notification` 0.7.2 references quick-xml
only as `quick_xml::escape::escape` while constructing notification XML. It
passes that text to the Windows `XmlDocument` parser. It does not invoke any
affected quick-xml parser API.

The repository gate verifies the exact dependency path and reads the fetched
crate source on every run. It fails if:

- another RustSec vulnerability appears;
- the crate or version changes;
- any quick-xml reference is not the reviewed escape function;
- an affected parser API appears;
- either advisory disappears while its stale exception remains; or
- 31 October 2026 has passed.

This is a narrow reachability exception, not a claim that the advisory is
incorrect. Update or remove it as soon as the notification dependency can
consume a patched quick-xml version.

Cargo audit also surfaces informational notices for transitive non-Windows UI
dependencies present in the cross-platform lockfile. Those notices remain
visible in gate output; they are not silently promoted to vulnerability
exceptions.
