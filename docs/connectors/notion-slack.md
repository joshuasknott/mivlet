# Notion and Slack production connectors

Fable's desktop runtime uses the providers' supported OAuth 2 authorization-code flows. OAuth state and PKCE verifiers, access tokens, refresh tokens, and revocation material are stored only through the native OS keyring boundary. The React and TypeScript layers never receive stored credentials. Connector identity and non-secret scope metadata persist separately so connection state survives restart.

## Auth broker and callbacks

The auth broker is implemented in `apps/broker` (targeting Cloudflare Workers for production deployment), but it is not yet deployed in production.
The full broker contract — including the non-proxying boundary, the fail-closed
configuration checks, and the local-first guarantees — is documented in
[Auth broker contract](auth-broker.md). The desktop fails closed for Notion and
Slack until a broker is deployed and configured.

Notion public integrations and Slack apps are confidential clients. Set `FABLE_AUTH_BROKER_URL` to the HTTPS base URL of a broker that owns the provider client secrets and implements:

- `GET /oauth/{notion|slack}/authorize`
- `GET /oauth/{notion|slack}/callback`
- `POST /oauth/{notion|slack}/handoff`
- `POST /oauth/{notion|slack}/refresh`
- `POST /oauth/{notion|slack}/revoke`

The desktop starts OAuth with PKCE and an exact HTTPS or loopback callback. Register the broker's provider callback in the Notion integration and Slack app consoles; the broker redirects a single-use handoff ticket and state to the exact desktop redirect. Local broker URLs may use `http://127.0.0.1` or `http://[::1]`; production must use HTTPS.

## Notion

Create a public Notion integration with read content and, when writes are enabled, insert/update content and comment capabilities. Install it into the intended workspace. Users must explicitly share each page or database with the integration. Search therefore means “content shared with this integration,” never workspace-wide access. Child blocks and database results are paginated.

Implemented API operations: search; page metadata; paginated block trees; database queries; create/update pages and database entries; append/update/archive blocks; and create comments. Every write is prepared with workspace, destination, target, exact JSON body, and changed-property names. Archiving a block has a critical warning. Provider features outside these operations, including unrestricted workspace discovery and provider features awaiting Notion review, are not claimed.

## Slack

Create and distribute a Slack app, enable OAuth v2, and install it separately in each workspace. Typical read scopes are `channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read`, and (when provider policy permits it) `search:read`. Writes require `chat:write`; reactions require `reactions:write`. Slack only returns conversations covered by the installed token and scopes, and private-channel access normally requires the app to be present in that channel.

## Sync and cache lifecycle

- **Manual queries only:** Fable does not crawl entire Slack message history or index complete Notion page databases. It queries the Notion and Slack APIs on demand based on specific user composer directives.
- **Cache limitation:** Fable retains connector configuration, channel names, page metadata titles, and granted permission scopes locally. No message bodies, document content, or confidential conversation histories are stored in persistent local caches. Imported items are session-local.
- **Data controls:**
  - **Resync:** Re-evaluates connection health and re-fetches accessible channels or databases to clear stale lists.
  - **Disconnect:** Removes Notion or Slack tokens from the secure OS credential boundary, revokes Slack tokens remotely if supported, and clears local configuration references.
- **Stale states:** Expired credentials or revoked integrations (e.g. if the Fable integration is removed from a Notion workspace or the Slack app is uninstalled) place the connector in a stale or unauthenticated state, requiring a fresh reconnection flow via the auth broker callback.

## Development and tests

Production paths never fall back to fixtures. Deterministic fixtures and mocked HTTP responses are test-only. Live tests are opt-in through `FABLE_LIVE_CONNECTOR_TESTS` and must obtain deliberately supplied credentials through the native credential boundary; credentials and provider content must never be committed or logged.

Use `pnpm check` plus `cargo test`, `cargo fmt --check`, and `cargo clippy -- -D warnings` before integration. Provider console creation, public distribution/review, and production broker deployment remain external release work.
