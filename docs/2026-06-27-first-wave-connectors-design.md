# First-wave connector implementation

## Scope

Fable's first connector wave is GitHub, Vercel, Google Drive, Notion, Gmail,
Slack, and Google Calendar. Local Files remains a separate, working native
connector. This phase makes every first-wave provider visible and gives each a
typed fixture adapter, honest setup/auth state, searchable preview data,
KnowledgeSource-compatible imports, and approval-gated action preparation.

Live provider network calls are deliberately outside the pure TypeScript
package. The Rust runtime owns the future credential and egress boundary.

## Connector interface

`@fable/protocol` defines:

- stable connector ids and auth states;
- status, health, requested/granted permissions, account summary, and setup
  metadata;
- search, import, provider error, and action request/result objects;
- action risk plus the `ApprovalRequest` that must be resolved before a write,
  send, publish, delete, promote, create, or update operation can execute.

`@fable/connectors` contains one pure module per provider. A module may
normalize synthetic provider payloads, shape a request, classify an error, and
prepare an approval-gated action. It must not read credentials or perform
network calls.

The Tauri command layer accepts and returns protocol-shaped data. Until OS
secure storage and provider configuration exist, auth and live execution fail
closed with `configuration-required`; fixture search stays available only in
the browser/preview adapter.

## Authentication mode by provider

| Provider | Intended mode | Initial permission boundary |
| --- | --- | --- |
| GitHub | GitHub App user authorization through an Fable auth broker | Read metadata, contents, branches, issues, and pull requests; draft PR/comment writes require approval |
| Vercel | Connectable-account External Flow through an Fable auth broker | Read projects/deployments; promote and rollback require approval |
| Google Drive | Installed desktop OAuth with PKCE and loopback redirect | `drive.file` with an explicit picker; import selected files only |
| Notion | Public connection OAuth through an Fable auth broker | Read content capability on user-selected pages/workspaces |
| Gmail | Installed desktop OAuth with PKCE and loopback redirect | `gmail.readonly`; `gmail.compose` is optional and only used for approval-gated drafts |
| Slack | OAuth v2 through an Fable auth broker | Read only installed/selected conversations; `chat:write` is optional and approval-gated |
| Google Calendar | Installed desktop OAuth with PKCE and loopback redirect | Read calendar list/events; event-write scope is optional and approval-gated |

Google documents desktop clients as public clients that cannot keep a client
secret and recommends PKCE with a loopback listener. Refresh tokens must be
stored in OS secure storage. GitHub App, Vercel, Notion, and Slack token
exchange needs server-held credentials or signing material, so Fable must use
an auth broker rather than embedding secrets in the frontend or desktop
binary.

## Read and write boundary

Search, list, preview, and explicit import are read operations. Imported
external content is `untrusted` by default, retains provider provenance and
freshness, and does not become durable memory without the existing memory
promotion approval.

Every provider action is prepared first. The adapter supplies a risk level,
consequence, data scope, and `ApprovalRequest`. Execution requires a matching
approved resolution at the Rust boundary. Draft creation is still a write and
requires approval. Sending mail, posting Slack messages, publishing,
promoting, rolling back, and destructive actions require high-risk/full-access
confirmation.

## Credential and local-data model

- Access and refresh tokens belong in OS secure storage behind a Rust
  `ConnectorCredentialBoundary`; no token getter is exposed to JavaScript.
- OAuth client secrets, GitHub App private keys, and broker credentials never
  ship in the frontend or desktop bundle.
- Local state may persist connector id, auth state, account summary, granted
  scope names, last health check, and imported normalized records, but never
  raw tokens or provider payloads.
- Runtime errors and logs redact authorization headers, cookies, token-shaped
  values, email bodies, Slack messages, Drive/Notion content, and raw provider
  responses.
- Disconnect revokes remotely where the provider supports it, clears secure
  storage, and retains only user-approved imported records.

## Tests

- registry presence and stable ids;
- provider normalizers, request shaping, action risk, and error mapping using
  synthetic fixtures;
- Gmail and Google Calendar catalog/UI presence;
- setup, needs-auth, expired, rate-limit, permission, unavailable, and fixture
  states;
- fixture search/import into untrusted KnowledgeSource records;
- approval-gated draft/write actions;
- Rust configuration-required behavior, approval validation, and redaction.

No test requires a network connection or real credentials.

## Provider-console work that code cannot complete

- Register the GitHub App and configure its callback/broker, permissions, and
  installation policy.
- Create the Vercel integration and configure its External Flow redirect and
  read/write API scopes.
- Create Google desktop OAuth credentials, enable Drive/Gmail/Calendar APIs,
  configure the consent screen, request verification for Gmail restricted
  scopes, and approve the loopback callback model.
- Create a Notion public connection and configure redirect URIs plus read
  content capability.
- Create and distribute a Slack app, configure an HTTPS redirect/broker,
  choose bot/user scopes, and enable token rotation.
- Provision the Fable auth broker and production callback URLs.
- Select and integrate a production OS secure-storage implementation for every
  supported platform.

Until those items exist, the UI must say configuration is required and must
not claim a live connection.

## Official references

- [GitHub OAuth scopes and GitHub App recommendation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Vercel integration setup and API scopes](https://vercel.com/docs/integrations/create-integration/submit-integration)
- [Google OAuth for desktop apps and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Gmail scopes and verification classes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Notion public connections](https://developers.notion.com/guides/get-started/public-integrations)
- [Notion connection capabilities](https://developers.notion.com/reference/capabilities)
- [Slack OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth)
- [Slack scopes](https://docs.slack.dev/reference/scopes/)
