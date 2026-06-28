# Google Drive, Gmail, and Calendar

## Provider setup

Create a Google Cloud project, enable the Drive, Gmail, and Calendar APIs that
the deployment will expose, configure the OAuth consent screen, and create an
OAuth client of type **Desktop app**. Set `FABLE_GOOGLE_CLIENT_ID` in the desktop
runtime. Desktop clients do not ship a client secret.

During development, keep the consent screen in testing and add each deliberate
test account as a test user. Fable binds an ephemeral
`http://127.0.0.1:<port>/callback` listener and uses Authorization Code with
S256 PKCE. State, callback host/path/port, verifier, and account identity are
validated before tokens are accepted.

Google may require OAuth app verification before external rollout. Gmail
restricted scopes can require additional security assessment. Provider console
configuration, verification, and test credentials are external prerequisites;
live tests remain opt-in with `FABLE_GOOGLE_LIVE_TEST`.

## Scopes and accounts

Authorization is incremental. Metadata/read scopes are requested first and
write scopes only when the user enables a corresponding capability. The runtime
does not claim access that is absent from the returned grant. When Google omits
a refresh token during incremental consent, the existing account refresh token
is retained.

Multiple accounts can be connected per Google connector. One account is
explicitly active, the UI exposes account selection, and disconnect removes only
the selected account before promoting another remaining account.

## Runtime behavior

Drive supports search, metadata, folder traversal, download and Google-format
export, plus approved create, content update, rename, move, share, and delete.
Gmail supports search, messages, threads, attachment metadata, drafts, replies,
and sends. Calendar supports calendar lists, events, free/busy, recurrence,
timezones, attendees, create, update, cancel, and delete.

Every mutation crosses the native one-time approval boundary immediately before
egress. Gmail send previews include the active sender, To, CC, BCC, subject,
body, and attachments. Mutations are never automatically retried, preventing a
transport ambiguity from duplicating mail, files, permissions, or events.

Responses are capped while streaming and normalized before entering model
context. Pagination cursors remain explicit. Cancellation interrupts request
egress, response reads, and retry backoff. Credentials stay in OS secure
storage; React receives only account and scope metadata.

## Verification

Default checks use mocked local HTTP responses and do not require credentials.
Run `pnpm check`, `cargo test`, and `cargo fmt --check`. Live provider checks
must be deliberately enabled and must never log or commit tokens or provider
content.
