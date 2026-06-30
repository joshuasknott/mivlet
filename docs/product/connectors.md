# Connectors

## First wave

Fable's first-wave external connectors are GitHub, Vercel, Google Drive,
Notion, Gmail, Slack, Google Calendar, and Linear. Local Files remains a native
local connector.

The browser preview uses synthetic fixture records (labeled `fixture`) and persists state in `localStorage` instead of the encrypted SQLite store. The desktop runtime uses authenticated production paths when provider
configuration is available and the user connects an account. Fable must never
translate a missing credential into a connected state, and production desktop
search/read/write paths do not silently fall back to fixture data.

Every connector exposes:

- setup/auth status and auth mode;
- health and last-check time;
- requested and granted scopes;
- account/workspace identity after a verified connection;
- scoped search/list and explicit import;
- normalized provider errors;
- prepared write actions that include an Fable `ApprovalRequest`.

## Provider setup

| Provider | Console setup | Callback model | Initial access |
| --- | --- | --- | --- |
| GitHub | Register a GitHub OAuth App through the auth broker | Broker callback, proposed `https://auth.fable.app/oauth/github/callback` | Account identity, organization membership, repositories, issues, and pull requests read; live GitHub writes are not enabled in this batch |
| Vercel | Create a connectable-account integration and select API permissions | External Flow redirect, proposed `https://auth.fable.app/oauth/vercel/callback` | Team, project, deployment, domain, log, and environment-variable metadata read; deployment/project/domain writes only when enabled |
| Linear | Create an OAuth application and select workspace scopes | Broker callback, proposed `https://auth.fable.app/oauth/linear/callback` | Workspace, team, project, cycle, issue, comment, label, and user read; issue/comment mutation only when enabled |
| Google Drive | Enable Drive API, configure consent, create a Desktop app OAuth client, set `FABLE_GOOGLE_OAUTH_CLIENT_ID` | Dynamic loopback `http://127.0.0.1:<port>/callback` | `drive.file` plus OpenID identity |
| Notion | Create a public connection and select connection capabilities | Broker callback, proposed `https://auth.fable.app/oauth/notion/callback` | Read content on user-selected pages/workspaces |
| Gmail | Enable Gmail API, configure consent/verification, create a Desktop app OAuth client, set `FABLE_GOOGLE_OAUTH_CLIENT_ID` | Dynamic loopback `http://127.0.0.1:<port>/callback` | `gmail.readonly`; optional `gmail.compose` and `gmail.send` |
| Slack | Create/distribute a Slack app, configure scopes and token rotation | HTTPS broker callback, proposed `https://auth.fable.app/oauth/slack/callback` | Selected conversation read scopes; optional `chat:write` |
| Google Calendar | Enable Calendar API, configure consent, create a Desktop app OAuth client, set `FABLE_GOOGLE_OAUTH_CLIENT_ID` | Dynamic loopback `http://127.0.0.1:<port>/callback` | Calendar-list and event read; optional event write |

The proposed broker callback host is documentation only. It is not active until
the broker is deployed and the exact confidential-provider URLs are registered.
Google does not use that host: its desktop client supplies a fresh loopback port
for each authorization attempt.

GitHub OAuth currently requests `read:user`, `read:org`, and `repo` through the
broker so private repository, issue, and pull request reads can work. GitHub's
OAuth `repo` scope is broader than Fable's live surface; the desktop runtime
does not advertise or map GitHub live writes, and unsupported GitHub mutations
fail closed.

Vercel should request team/account read plus Project, Deployment, Domain, Log,
and Environment Variable read metadata permissions. Deployment write is needed
for approved create/cancel/promote/rollback actions; project/domain write is
needed only for approved configuration changes. Environment-variable secret
values must never be returned to the model, audit log, or fixture snapshots.

Linear should request read scopes for workspace metadata, teams, projects,
cycles, issues, comments, labels, and users. Issue create/update and comment
write scopes are needed only for approved issue/comment mutations. Status,
assignment, project, cycle, and label changes are represented as issue updates
when the connected workspace grants them.

Slack public-channel imports need `channels:read` and `channels:history`.
Private-channel support additionally needs the corresponding `groups:*`
scopes, and the app must be present in the selected conversation. `chat:write`
is optional and never authorizes an automatic post.

Google Calendar read mode uses
`calendar.calendarlist.readonly` and `calendar.events.readonly`. Event
create/update requires `calendar.events`.

Google classifies `gmail.readonly` and `gmail.compose` as restricted scopes.
Production use requires the applicable OAuth verification and, when restricted
data is transmitted or stored on servers, may require a security assessment.

## Google production connector setup

The implementation and operational setup are detailed in
[Google Drive, Gmail, and Calendar](../connectors/google.md).

Google Drive, Gmail, and Google Calendar share the direct desktop public-client
Authorization Code + PKCE implementation:

- create a Google Cloud project;
- enable the Google Drive API, Gmail API, and Google Calendar API as needed;
- configure the OAuth consent screen and add local developers as test users
  while the app is in testing mode;
- create a **Desktop app** OAuth client;
- set its public client id as `FABLE_GOOGLE_OAUTH_CLIENT_ID` in the environment
  that launches the desktop app.

The desktop binds `http://127.0.0.1:<port>/callback`, sends the exact redirect
and PKCE S256 challenge directly to Google, validates state and redirect before
exchange, and stores tokens only through the native credential boundary. Google
refresh tokens and granted scopes are preserved when a refresh response omits
replacements. The confidential broker is not involved.

Fable requests only required scopes on the default connection attempt. Optional
capabilities require a deliberate incremental authorization request before the
operation; the runtime fails closed if the needed scope is absent:

| Connector | Initial read scopes | Incremental scopes |
| --- | --- | --- |
| Google Drive | `https://www.googleapis.com/auth/drive.file` | Same bounded file grant for create/update/move/rename/share/delete on files opened or created with Fable |
| Gmail | `https://www.googleapis.com/auth/gmail.readonly` | `https://www.googleapis.com/auth/gmail.compose` for drafts; `https://www.googleapis.com/auth/gmail.send` for explicit sends |
| Google Calendar | `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events.readonly` | `https://www.googleapis.com/auth/calendar.events` for create/update/cancel/delete |

Google Drive supports metadata search/read, supported file downloads,
Google Docs/Sheets/Slides export, and approved create/update/move/rename/share/
delete actions. Gmail supports search, message/thread reads, attachment
metadata, draft creation, and explicit sends. Google Calendar supports calendar
listing, event reads, event details, free/busy checks, and approved event
create/update/delete actions.

Google write actions require a fresh explicit approval. Standing session/rule
grants are intentionally not accepted for Google mutations. Gmail sends also
require per-message approval and show the sending account, recipients, subject,
body preview, and attachments before execution.

## Read and write behavior

Read operations list/search only the resources granted by the provider and
selected by the user. Imports are copied into a normalized `KnowledgeSource`
record with:

- connector id, provider item id, title, and kind;
- provenance and provider metadata;
- freshness and import time;
- a short preview when permitted;
- `trust: untrusted` and `origin: connector-import`.

Imported content is not durable memory. The existing memory-promotion approval
is the only path from connector knowledge to durable memory.

Draft creation is a provider write and requires approval even when it does not
send or publish. Sending Gmail, posting Slack,
Vercel deployment/configuration changes, Linear issue/comment changes, and any
public/destructive action use high-risk full-access confirmation. No adapter
executes a consequential write directly; the native runtime records a prepared
approval preview and requires a matching explicit user decision before egress.

The native AI runtime exposes read-only tools for authenticated GitHub, Vercel,
and Linear capabilities. These call the live provider APIs only after native
credential resolution and return structured items with pagination and rate-limit
metadata. Supported non-GitHub write capabilities are functional provider calls
only after the same explicit approval boundary and only when the connector is
actually connected.

## Credential storage and auth broker

The auth broker is implemented in `apps/broker` and synthesised targeting Cloudflare Workers.
The narrow broker contract, its non-proxying boundary, the fail-closed
configuration checks, and the local-first guarantees are documented in
[Auth broker contract](../connectors/auth-broker.md). Confidential-client
connectors (GitHub, Vercel, Notion, Slack, Linear) fail closed until your Cloudflare Workers broker is
deployed and configured; the core desktop workspace and Google public-client (PKCE) connectors
do not depend on it.

Google OAuth is independent of the broker. Its loopback listener receives the
Google authorization code, and the native credential boundary exchanges and
stores access and refresh tokens without exposing them to React or localStorage.

GitHub OAuth client secret and the Vercel, Notion, and Slack client secrets
must remain in an Fable auth broker or equivalent server-side secret boundary.
They must not be compiled into React assets, Rust binaries, logs, snapshots,
or local JSON state.

The Rust connector credential boundary stores access tokens, refresh tokens,
PKCE verifier state, and account metadata through the OS credential/keyring
boundary. The app data files hold non-secret connection state only: connector
id, account summary, scopes, expiry, status, health, and opaque credential
references. Auth broker endpoints perform confidential-client authorization,
one-time handoff redemption, refresh, internal identity resolution, and
revocation for GitHub, Vercel, Linear, Notion, and Slack.
The Rust `ConnectorCredentialBoundary` is fail-closed: if a credential or token
is missing, unavailable, expired without refresh, or lacks the required scope,
live commands return a normalized connector error instead of using fixtures or
claiming access.

## Local cache, logging, and disconnect

Fable may cache connector id, account summary, scope names, health, normalized
import metadata, and user-approved previews. Raw provider responses are not
the cache format. Email bodies, Slack messages, Drive/Notion text, cookies,
authorization headers, and token-shaped values are excluded from logs and
runtime errors.

Synced connector data is persisted in the encrypted local vault's
`connector_cache` table (schema v2). Each cached row is scoped to a
`workspace_id` and `connector_id` so workspaces never cross-pollinate, and is
searchable by title/provenance/preview without decryption. The cache lifecycle
is fully controlled through dedicated commands:

- **cache/disable** — per-workspace and per-connector settings (`enabled`,
  `auto_sync`) gate whether the cache writes or reads; a disabled scope never
  accepts new rows.
- **delete** — individual cached items can be soft-disabled (excluded from
  search/retrieval but retained and auditable) or hard-deleted, always scoped to
  the requesting workspace.
- **clear-cache** — a workspace's cache (optionally one connector) can be
  cleared; workspace isolation guarantees other workspaces are untouched.
- **resync** — a workspace/connector's rows can be re-stamped as freshly
  resynced after a re-pull.
- **export** — a workspace's cached data exports as credential-free JSON
  (secrets never reach the cache, so the export is safe by construction).

Provider secrets/tokens never enter the cache: the Rust write path recursively
redacts token-shaped values and fails closed when a secret marker survives
redaction. Provider tokens remain in OS secure storage under a separate
lifecycle.

Disconnect should revoke provider authorization where supported, clear access
and refresh tokens from secure storage, reset account/scopes/health, and keep
only imported records the user has chosen to retain. Slack tokens can also be
revoked through `auth.revoke`; provider-side app removal must be handled as an
expired/unavailable auth state.

## Known limitations

- The Fable auth broker and production callback URLs must be deployed and
  registered before external users can connect GitHub, Vercel, Linear, Notion,
  or Slack.
- Provider apps, consent screens, distribution review, and Google restricted
  scope verification are external setup tasks.
- Browser search/import remains synthetic fixture behavior only.
- Tauri provider egress code exists for authenticated GitHub, Vercel, Linear,
  Google Drive, Gmail, Google Calendar, Notion, and Slack accounts, but each
  path remains gated by its credential boundary and provider setup. Undeclared
  capabilities still fail closed.
- Synced connector data is cached in the encrypted local vault (`connector_cache`,
  schema v2). The cache is searchable, workspace-isolated, and secret-free: the
  write path redacts token-shaped values and fails closed when a secret marker
  survives. Per-workspace and per-connector cache settings gate writes/reads,
  and disable/delete/clear/resync/export lifecycle commands preserve workspace
  isolation. Provider tokens stay in OS secure storage and never enter the cache.
- GitHub coverage is live-read only for repositories, issues, and pull requests;
  live GitHub writes intentionally fail closed.
- Live Google integration tests are opt-in and require deliberately supplied
  credentials and test account data.
- Live Notion and Slack integration tests are opt-in and require deliberately
  supplied workspace credentials and test targets.

## Official provider references

- [GitHub OAuth App scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Vercel integration API scopes and redirect](https://vercel.com/docs/integrations/create-integration/submit-integration)
- [Vercel REST API](https://vercel.com/docs/rest-api)
- [Linear OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)
- [Linear GraphQL API](https://linear.app/developers/graphql)
- [Google desktop OAuth and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Notion public connections](https://developers.notion.com/guides/get-started/public-integrations)
- [Notion capabilities](https://developers.notion.com/reference/capabilities)
- [Slack OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth)
- [Slack scopes](https://docs.slack.dev/reference/scopes/)
