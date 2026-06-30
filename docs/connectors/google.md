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
