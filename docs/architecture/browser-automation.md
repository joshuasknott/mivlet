# Browser automation architecture

> [!WARNING]
> **Status: local human control and bounded approved agent controls implemented; richer automation remains deferred**
> The desktop app can start a real local Edge/Chrome/Chromium process per
> workspace/agent, render an ephemeral screen in Fable, and let the user take
> and return control. An exact, one-time-approved agent tool can navigate a
> provisioned local browser and receives only a bounded final title and origin.
> A separate observation returns only bounded,
> visible, non-secret named controls; exact single-use refs support approved
> click, fill, and key actions. Rich page understanding still fails closed; the
> hosted browser transport remains deployment-gated. Preview egress remains
> explicitly fixture-backed.

The browser automation boundary is designed as a **consequence-aware, local-first isolation layer** that evaluates browser actions before they are executed. No browser action is allowed to run silently or bypass permission rules.

## Mental model

Browser automation operates within a strict run and session binding:
1. **Run & Session Isolation**: Every browser action proposal is explicitly bound to a parent agent run ID and an active browser session ID. Actions attempting to execute across runs or sessions fail closed.
2. **Permission Gating**: Every action is evaluated against the user's active permission profile (`read-only`, `trusted-scope`, or `full-access`).
3. **Audit Visibility**: Every prepare, resolve, and completion event is audited locally in the encrypted SQLite database with strict redaction of sensitive arguments and secrets.

## Session derivation and bounds

Sessions are derived dynamically in the shell runtime based on connector manifest health:
- **Live Session**: Derived when first-wave connectors (GitHub, Slack, etc.) are connected. The session connector list matches the connected status.
- **Fixture Preview Session**: An explicitly labeled `fixture-preview` session used in browser mode for synthetic previews. It expires after 30 minutes.
- **Unavailable Session**: Fails closed if no active connectors or preview configurations are available.

## Risk levels and policy mapping

Browser automation actions are mapped onto permission effects and risk levels:

| Action | Effect | Risk Level | Consequence |
| :--- | :--- | :--- | :--- |
| `browser.read-url` | `browser-read` | Low | Read current browser tab URL. Safe without approval in read-only. |
| `browser.read-title` | `browser-read` | Low | Read current browser tab title. Safe without approval in read-only. |
| `browser.navigate` | `browser-state-mutation` | Medium | Navigate to a new URL. Requires approval. |
| `browser.click` | `browser-state-mutation` | High | Click a browser control. Requires approval. |
| `browser.type` | `browser-state-mutation` | High | Type text into a field. Requires approval. |
| `browser.select` | `browser-state-mutation` | High | Select options. Requires approval. |
| `browser.download` | `local-write` | High | Download resource. Requires approval. |
| `browser.screenshot` | `browser-state-mutation` | High | Capture viewport. Requires approval. |
| `browser.submit` | `publish-external` | Critical | Submit browser form. Requires approval + confirmation. |
| `browser.upload` | `publish-external` | Critical | Upload local files. Requires approval + confirmation. |
| `browser.clipboard-read` | `browser-state-mutation` | Critical | Read system clipboard. Requires approval + confirmation. |
| `browser.clipboard-write` | `publish-external` | Critical | Write system clipboard. Requires approval + confirmation. |

## Security invariants and controls

To preserve user privacy and security, the browser automation boundary implements the following controls:

- **No Secret Leakage**: Access tokens, refresh tokens, credentials, cookies, and password-shaped arguments are filtered at the audit storage boundary. If a value matches a secret shape or key name, it is redacted to `[redacted]`.
- **No Page-Content Leakage**: HTML DOM dumps, page text, screenshots, and clipboard data are never persisted in the runtime snapshot, ordinary logs, or SQLite databases.
- **Explicit Fixture Masquerade Prevention**: Preview data results are strictly marked with `source: "fixture"` and summaries are prefixed with `Preview data only:`. Preview adapters never silently masquerade as live production connections.

## Local user-control browser

The native local-computer boundary is deliberately narrower than the automated
action architecture above:

- Each workspace/agent scope derives an opaque Fable-owned directory. Browser
  profile paths, cookies, DevTools endpoints, and process handles remain native.
- User-entered navigation accepts credential-free HTTP(S) URLs only. URL
  fragments are removed before navigation and credentials in URLs are rejected.
- The screen is a bounded JPEG frame that is never written to Fable's database,
  transcript, runtime snapshot, or ordinary logs.
- Control changes increment a generation fence. Pointer and keyboard input must
  cite the current generation and fail after control changes or stale frames.
- The browser launches with its own persistent profile, Chromium's sandbox, and
  certificate-error bypass disabled. Website sign-in can happen inside that
  browser, although provider-specific OAuth and passkey compatibility is not yet
  certified; Fable does not copy cookies or private session tokens.
- Approved model navigation starts the provisioned browser when needed, refuses
  to act during human takeover, and returns only a bounded title plus final
  origin. User information, path, query, and fragment are removed.
- Approved model observation exposes at most 40 visible named controls as
  external-untrusted evidence. A native single-select can expose up to 50
  visible, enabled labels but never internal option values. It omits
  secret-shaped fields and all page body, screenshot, cookie, clipboard, and
  hidden-state data. Exact refs are consumed by one approved click, non-secret
  fill, exact-label selection, or allowlisted key action.
- This is browser-process/profile isolation, not a separate OS account,
  container, or VM. See [local teammate computer](local-teammate-computer.md).

## Deferred / Not implemented

The following capabilities are not implemented locally:

- General page-text/DOM inspection, explicit submit semantics,
  downloads/uploads, and multi-tab workflows beyond the bounded control layer.
- A full visible Chromium chrome surface, downloads UI, popup/tab management,
  uploads, passkeys, or system clipboard integration.
- Container/VM-backed application and terminal isolation.
- Production auth-broker deployment and live provider OAuth certification.
