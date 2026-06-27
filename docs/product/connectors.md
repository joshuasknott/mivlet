# Connectors

## First wave

Fable's first-wave external connectors are GitHub, Vercel, Google Drive,
Notion, Gmail, Slack, and Google Calendar. Local Files remains a native local
connector.

The browser preview uses synthetic fixture records and labels them `fixture`.
The desktop runtime uses authenticated production paths for Google Drive,
Gmail, and Google Calendar when a Google OAuth client is configured and the
user connects an account. Other first-wave provider runtime paths still report
`needs-auth` or `configuration-required` until their provider configuration is
implemented. Fable must never translate a missing credential into a connected
state.

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
| GitHub | Register a GitHub App and installation policy | Broker callback, proposed `https://auth.fable.app/oauth/github/callback` | Metadata, contents, issues, and pull requests read; issue/PR write only when enabled |
| Vercel | Create a connectable-account integration and select API permissions | External Flow redirect, proposed `https://auth.fable.app/oauth/vercel/callback` | Project and deployment read; deployment write only when enabled |
| Google Drive | Enable Drive API, create Desktop OAuth client, configure consent | Dynamic loopback `http://127.0.0.1:{port}` with PKCE | `drive.metadata.readonly`; incremental `drive.readonly` and `drive.file` |
| Notion | Create a public connection and select connection capabilities | Broker callback, proposed `https://auth.fable.app/oauth/notion/callback` | Read content on user-selected pages/workspaces |
| Gmail | Enable Gmail API, create Desktop OAuth client, configure consent and verification | Dynamic loopback `http://127.0.0.1:{port}` with PKCE | `gmail.readonly`; optional `gmail.compose` |
| Slack | Create/distribute a Slack app, configure scopes and token rotation | HTTPS broker callback, proposed `https://auth.fable.app/oauth/slack/callback` | Selected conversation read scopes; optional `chat:write` |
| Google Calendar | Enable Calendar API, create Desktop OAuth client, configure consent | Dynamic loopback `http://127.0.0.1:{port}` with PKCE | Calendar-list and event read; optional event write |

The proposed production callback host is documentation only. It is not active
until the auth broker is deployed and the exact URLs are registered in each
provider console.

GitHub App permissions should start with repository Metadata read, Contents
read, Issues read, and Pull requests read. Draft PRs/comments require the
narrow corresponding write permission and Fable approval.

Vercel should request Project and Deployment read permissions. Deployment
write is optional and only needed for approved promote/rollback actions.

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

Google Drive, Gmail, and Google Calendar share the desktop OAuth implementation:

- create a Google Cloud project;
- enable the Google Drive API, Gmail API, and Google Calendar API as needed;
- configure the OAuth consent screen and add local developers as test users
  while the app is in testing mode;
- create an OAuth client with application type `Desktop app`;
- provide the client id through the desktop connector configuration;
- use the loopback redirect URI that Fable opens for the active authorization
  attempt.

The desktop flow uses Authorization Code with PKCE, validates the returned
OAuth state and callback values, and stores access/refresh tokens only through
the native credential boundary. Google refresh tokens are reused across
incremental scope grants when Google returns only a new access token.

Fable requests only required scopes initially and asks for optional scopes
when a user invokes capabilities that need them:

| Connector | Initial read scopes | Incremental scopes |
| --- | --- | --- |
| Google Drive | `https://www.googleapis.com/auth/drive.metadata.readonly` | `drive.readonly` for downloads/exports; `drive.file` for create/update/move/rename/share/delete |
| Gmail | `https://www.googleapis.com/auth/gmail.readonly` | `gmail.compose` for drafts and sends |
| Google Calendar | `calendar.calendarlist.readonly`, `calendar.events.readonly` | `calendar.events` for create/update/delete |

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
send or publish. Sending Gmail, posting Slack, promoting or rolling back
Vercel, and any public/destructive action use high-risk full-access
confirmation. No adapter executes a write directly.

## Credential storage and auth broker

Google desktop OAuth is a public-client PKCE flow. A loopback listener receives
the authorization code; access and refresh tokens are written through OS secure
storage/keyring. The desktop app does not rely on a client secret.

GitHub App signing material and the Vercel, Notion, and Slack client secrets
must remain in an Fable auth broker or equivalent server-side secret boundary.
They must not be compiled into React assets, Rust binaries, logs, snapshots,
or local JSON state.

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

Disconnect should revoke provider authorization where supported, clear access
and refresh tokens from secure storage, reset account/scopes/health, and keep
only imported records the user has chosen to retain. Slack tokens can also be
revoked through `auth.revoke`; provider-side app removal must be handled as an
expired/unavailable auth state.

## Known limitations

- The Fable auth broker and production callback URLs are not deployed.
- Provider apps, consent screens, distribution review, and Google restricted
  scope verification are external setup tasks.
- Browser search/import remains synthetic fixture behavior only.
- Non-Google provider production egress remains pending.
- Imported connector records are session-local until encrypted connector cache
  persistence is added.
- Live Google integration tests are opt-in and require deliberately supplied
  credentials and test account data.

## Official provider references

- [GitHub OAuth scopes and GitHub App recommendation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [Vercel integration API scopes and redirect](https://vercel.com/docs/integrations/create-integration/submit-integration)
- [Google desktop OAuth and PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Notion public connections](https://developers.notion.com/guides/get-started/public-integrations)
- [Notion capabilities](https://developers.notion.com/reference/capabilities)
- [Slack OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth)
- [Slack scopes](https://docs.slack.dev/reference/scopes/)
