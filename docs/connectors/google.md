# Google Drive, Gmail, and Calendar Connectors

Fable's Google connectors use a desktop public-client OAuth 2.0 Authorization
Code flow with PKCE. They do not use the confidential auth broker and no Google
client secret is required or supported in the desktop application.

## Provider setup

1. Create or select a Google Cloud project.
2. Enable the Google Drive API, Gmail API, and Google Calendar API for the
   connectors you intend to use.
3. Configure the OAuth consent screen. While the app is in testing, add every
   deliberate test account as a test user.
4. Create an OAuth client ID with application type **Desktop app**.
5. Set the public client ID in the environment that launches Fable:

   ```powershell
   $env:FABLE_GOOGLE_OAUTH_CLIENT_ID = "your-client-id.apps.googleusercontent.com"
   ```

The desktop binds an ephemeral loopback listener and supplies
`http://127.0.0.1:<port>/callback` as the exact redirect URI for each attempt.
Desktop-app clients accept loopback redirects with dynamic ports; there is no
fixed Google callback URL to register and no `FABLE_AUTH_BROKER_URL` dependency
for Google.

If `FABLE_GOOGLE_OAUTH_CLIENT_ID` is missing, Google connection attempts fail
closed with `configuration-required`. Fable never falls back to fixtures or a
false connected state.

## OAuth and credential boundary

The desktop sends the authorization request directly to Google with PKCE S256,
`access_type=offline`, a fresh state value, and an exact state/redirect check.
It does not send `include_granted_scopes`: Google's installed-app guidance says
incremental authorization is unsupported for installed apps. Fable treats each
Google reconnect as a request for the complete service-scope set needed for that
attempt, exchanges the returned code directly at Google's token endpoint,
resolves identity from Google OpenID userinfo, refreshes directly, and revokes
directly.

Access tokens, refresh tokens, and pending PKCE verifiers remain behind the
native OS credential boundary. React state, localStorage, logs, snapshots,
fixtures, documentation, exported data, and committed files contain no Google
tokens or client secrets. Account metadata exposed to UI code is limited to
non-secret identity, scope, expiry, health, and opaque credential references.

Multiple Google accounts can remain connected. The native runtime stores an
explicit active-account selection per Google connector; reads and approved
writes use only that selected account. Reconnect and refresh may preserve an
existing refresh token when Google omits a replacement, but Fable does not
preserve or merge historical scopes into the active credential.

## Scopes

All three connectors also request `openid email profile` for account identity.
Service scopes are requested from the connector's declared set for the current
connection attempt. The active credential's granted-scope truth comes from the
Google token response, or from a deliberate provider verification call such as
the opt-in live tokeninfo harness below. If Google omits `scope`, Fable records
no active service grants and disables gated search/import/action surfaces until
the account is reconnected or provider truth is obtained.

### Google Drive

- `https://www.googleapis.com/auth/drive.file` - see and change files created
  by, or explicitly opened with, Fable.

The native runtime also recognizes
`https://www.googleapis.com/auth/drive.metadata.readonly` and
`https://www.googleapis.com/auth/drive.readonly` when those broader read paths
are deliberately granted. Broad Drive content access should not be requested
by default; broader Drive scopes can trigger Google restricted-scope review and
security-assessment requirements.

### Gmail

- `https://www.googleapis.com/auth/gmail.readonly` - search and read mail.
- `https://www.googleapis.com/auth/gmail.compose` - create or update drafts.
- `https://www.googleapis.com/auth/gmail.send` - send an explicitly approved
  message.

Gmail read, compose, and send scopes are sensitive or restricted. External
production use requires Google's OAuth verification and, for restricted scopes,
the applicable restricted-scope verification and security-assessment process.
Unverified or unavailable Gmail capabilities remain fail-closed in the UI and
runtime rather than being advertised as usable.

### Google Calendar

- `https://www.googleapis.com/auth/calendar.calendarlist.readonly` - list
  calendars.
- `https://www.googleapis.com/auth/calendar.events.readonly` - read events.
- `https://www.googleapis.com/auth/calendar.events` - create, update, cancel,
  or delete events after explicit approval.

Calendar user-data scopes can still require OAuth app verification for external
production use even though they are not Gmail restricted scopes.

## Runtime behavior

The native runtime provides bounded, paginated Drive, Gmail, and Calendar reads,
normalizes safe provider errors, supports cancellation, refreshes once after an
expired-token response, and applies bounded retries only to safe read requests.
Partial item failures are represented without exposing raw provider bodies.

Every consequential Google mutation crosses the native fresh, single-use
approval boundary immediately before provider egress. Mutations are not
automatically retried after an ambiguous network or server failure because the
provider may already have applied the side effect.

The `@fable/connectors` package also exports `createGoogleDriveAdapter`,
`createGmailAdapter`, and `createGoogleCalendarAdapter`. These public-PKCE
adapters perform direct Google OAuth and API calls through the shared connector
contract. Their mocked tests cover pagination, cancellation, redaction,
refresh/revoke, approval gating, and per-service failure isolation.

## Current limits and data lifecycle

- **Manual, on-demand sync:** Reads are performed on demand when requested. There is no continuous background sync, scheduled polling, or automatic crawler indexing of your Google account data.
- **Cache boundaries:** Raw provider responses and unselected account content are not persisted. Account metadata, granted scopes, active status, connection health, and normalized user-selected cache items may be stored in the encrypted workspace-scoped cache. Tokens never enter that cache.
- **Stale states (Missing scopes):** If a user disconnects or unchecks required scopes during the Google authorization consent step, or if Google returns no active `scope` truth, the connector enters a permission-limited or stale state. A full reconnect is required to request and restore the missing required scopes.
- **Verification constraints:** Live-provider validation is not part of the default test suite and requires external Google Cloud configuration and deliberate test accounts.
- **Production blocking:** OAuth consent verification and any restricted-scope security assessment are external production blockers.

## Verification

Default checks use mocked HTTP and require no Google account:

```powershell
corepack pnpm --filter @fable/connectors test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml google
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml connector_auth
```

An opt-in live harness can validate an already-obtained test access token
without running OAuth or committing credentials:

```powershell
$env:FABLE_LIVE_CONNECTOR_TESTS = "1"
$env:FABLE_GOOGLE_TEST_TOKEN = "ya29..."
$env:FABLE_GOOGLE_TEST_EXPECTED_SCOPES = "https://www.googleapis.com/auth/gmail.readonly"
$env:FABLE_GOOGLE_TEST_EMAIL = "optional-test-user@example.com"
corepack pnpm --filter @fable/connectors test
```

The harness calls Google's tokeninfo endpoint and verifies the provider-returned
scope set. It must be run only with deliberate test accounts and throwaway
tokens.

Never place live tokens, email addresses, calendar IDs, file IDs, or provider
content in test fixtures, snapshots, logs, or committed files.
