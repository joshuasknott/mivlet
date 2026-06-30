# Google Drive, Gmail, and Calendar

## Provider setup

Google Drive, Gmail, and Calendar share the Fable auth broker. The broker is the
only place the Google OAuth client secret lives; the desktop never receives the
secret and never stores provider tokens in React state, localStorage, logs, docs,
or snapshots.

Create a Google Cloud project, configure the OAuth consent screen, enable the
Google APIs Fable will expose, and create a confidential OAuth client for the
Cloudflare Workers broker callback URLs:

- `https://<broker-origin>/oauth/google-drive/callback`
- `https://<broker-origin>/oauth/gmail/callback`
- `https://<broker-origin>/oauth/google-calendar/callback`

Set these broker-only variables in the Workers environment:

- `FABLE_BROKER_GOOGLE_CLIENT_ID`
- `FABLE_BROKER_GOOGLE_CLIENT_SECRET`

If either value is missing, the broker returns `configuration-required` and the
connector must remain unavailable. There is no desktop fallback.

During development, keep the consent screen in testing and add each deliberate
test account as a test user. Google may require OAuth app verification before
external rollout. Gmail restricted scopes can require additional security
assessment. Provider console configuration, verification, and test credentials
are external prerequisites; automated tests use mocked HTTP responses only.

## Scopes and accounts

The shared Google foundation requests OpenID identity (`openid email profile`)
plus service-specific scopes:

- Google Drive: `https://www.googleapis.com/auth/drive.file`
- Gmail: `https://www.googleapis.com/auth/gmail.readonly`,
  `https://www.googleapis.com/auth/gmail.compose`,
  `https://www.googleapis.com/auth/gmail.send`
- Google Calendar:
  `https://www.googleapis.com/auth/calendar.calendarlist.readonly`,
  `https://www.googleapis.com/auth/calendar.events.readonly`,
  `https://www.googleapis.com/auth/calendar.events`

The broker uses `access_type=offline`, `include_granted_scopes=true`, and
`prompt=consent` so refresh tokens and incremental grants are handled through
one lifecycle. When Google omits a refresh token during refresh or reconnect,
the runtime preserves the existing refresh token only inside the credential
boundary.

Account metadata is normalized from Google OpenID userinfo into id, display
name, email, and avatar URL. UI surfaces account and scope metadata only.

## Runtime behavior

Shared lifecycle behavior covers OAuth state, scope metadata, account metadata,
refresh, revoke, reconnect messaging, stale or expired token states, and partial
provider failures. Service-specific modules keep Drive, Gmail, and Calendar
payload normalization and approval-gated action behavior separate.

Drive supports selected-file access and approved file mutations. Gmail supports
search/read, drafts, and explicit sends. Calendar supports calendar/event reads
and approved event create, update, cancel, and delete.

Every mutation crosses the native one-time approval boundary immediately before
egress. Mutations are never automatically retried, preventing transport
ambiguity from duplicating mail, files, permissions, or events.

## Verification

Default checks use mocked local HTTP responses and do not require a Google
account. Run the connector and broker tests before release. Live provider checks
must be deliberately enabled and must never log or commit tokens, emails,
calendar IDs, file IDs, or provider content.

## TypeScript adapter status (implemented)

The `@fable/connectors` package ships live TypeScript adapters for all three
Google services. They are exported from `packages/connectors/src/providers/`
and implement the same `ConnectorAdapter` contract as the GitHub, Vercel, and
Linear adapters:

- `createGoogleDriveAdapter` (`google-drive.ts`)
- `createGmailAdapter` (`gmail.ts`)
- `createGoogleCalendarAdapter` (`google-calendar.ts`)

These adapters are additive to the existing normalizer/`prepare*` helpers; they
do not alter the fixture preview path. The shell wires them into a
`ConnectorRuntime` the same way it wires the developer connectors.

### Auth path

Google is a public-PKCE provider and is intentionally **excluded from the auth
broker** (`broker-contract.ts`: `BROKER_PROVIDER_IDS` lists only github, vercel,
linear, notion, slack). A new `googleOAuthClient` factory in `http.ts` performs
the full OAuth lifecycle directly against Google's OAuth2 endpoints, reusing
the existing token/identity parsing:

- `startAuth` — builds the authorization URL with PKCE (`S256`), `access_type=offline`, and `prompt=consent` so refresh tokens survive reconnects.
- `completeAuth` — validates the OAuth `state`, then exchanges the authorization `code` + PKCE verifier directly at Google's token endpoint (no broker handoff) and resolves account identity from the userinfo endpoint.
- `refresh` — direct `refresh_token` grant against Google; preserves the prior refresh token when Google omits one.
- `revoke` — direct revocation at Google's revoke endpoint; HTTP 404 is treated as idempotent success.

The runtime's `withTokenRefresh`/`withRetries` wrappers still apply: an
`expired-auth` error triggers one refresh + retry, and retryable errors back
off honoring `retryAfter`.

### Sync behavior

Reads map to the provider REST surfaces and walk `nextPageToken` cursors
through the shared `page()` helper (which also normalizes rate-limit headers).
Each service is a distinct `ConnectorId` with its own HTTP client, so a partial
failure in one Google service cannot corrupt another.

| Connector | Read capabilities | REST surface |
| --- | --- | --- |
| Google Drive | `drive.search`, `drive.read` | `GET /drive/v3/files` (list, `pageToken`), `GET /drive/v3/files/{id}` (metadata) |
| Gmail | `gmail.search`, `gmail.read` | `GET /gmail/v1/users/me/messages` (list, `pageToken`), `GET /.../messages/{id}?format=metadata` |
| Google Calendar | `calendar.list`, `calendar.read` | `GET /calendar/v3/users/me/calendarList`, `GET /calendars/{id}/events` (`singleEvents=true`, `pageToken`), single-event read |

Sync is deliberately conservative:

- **Drive** surfaces file metadata only (id, name, mimeType, times, links) via a narrow `fields` mask; binary/native content is never pulled. ACL/permission detail (`permissions`, `owners`, `permissionIds`) is redacted before the page leaves the adapter.
- **Gmail** list reads return message stubs (id/threadId) only; single-message reads use `format=metadata` (envelope headers + snippet). Raw message bodies and payload bytes are stripped (`raw`, `payload`, `sizeEstimate`) so full email content is never persisted by the read path.
- **Calendar** list/event reads return event metadata; conference data, hangout links, and attendee email addresses are redacted (attendee display names and response status are kept). Bare event lists default to upcoming events only via `timeMin`/`timeMax` to avoid backfilling entire histories.

Write capabilities (create/update/move/rename/share/delete for Drive,
create-draft/send for Gmail, create/update/cancel/delete for Calendar) are
mapped to the corresponding REST mutations but, like all consequential writes,
are gated by the runtime's per-action approval boundary — they never execute
without a matching explicit approval.

### Tests

`packages/connectors/src/providers/google-connectors.test.ts` covers the
adapters with mocked HTTP (injected `fetch` returning real `Response` objects,
no real Google account required): read path mapping, `nextPageToken`
pagination, rate-limit normalization, single-resource reads, redaction
(Drive ACLs, Gmail raw bodies, Calendar conference/attendee-email), error
states (401/403/429/network/malformed), cancellation propagation, the full
public-PKCE auth lifecycle (exchange/refresh/revoke), approval gating, and
per-service failure isolation. Live-network checks stay opt-in behind
`FABLE_LIVE_CONNECTOR_TESTS` and skip by default.

### Not yet implemented (follow-ups)

- Batch/backfill sync into the knowledge store (`ConnectorSourceProvider.listSources()` feeding `ingestCandidate`) — current reads are on-demand `adapter.read()` only; there is no scheduled polling orchestrator.
- Drive file content download and Docs/Sheets/Slides text export (the foundation supports it via a `fields`/`export` path, but the adapter does not yet pull content).
- Gmail thread reads, attachment metadata, and reply-to-thread writes.
- Calendar free/busy, recurrence expansion beyond `singleEvents=true`, and timezone-aware detail enrichment.
- Desktop shell wiring (instantiating the adapters in a `ConnectorRuntime`) and encrypted connector-cache persistence.
