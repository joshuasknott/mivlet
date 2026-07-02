# Browser automation architecture

> [!WARNING]
> **Status: Preview/fixture-only; headless transport deferred**
> The codebase includes the permission policy architecture, session derivation boundaries, and audit redaction rules. Live browser tool execution (e.g. driving a headless browser via Puppeteer or Playwright) is deferred. Egress remains synthetic fixture-backed in preview. Operations requiring live browser execution fail closed.

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

## Deferred / Not implemented

The following capabilities are out of scope for the current slice:
- Live headless browser engine (e.g. Puppeteer/Playwright listeners in Tauri).
- Multi-session local storage isolation for live browser profiles.
- Production auth-broker deployment.
