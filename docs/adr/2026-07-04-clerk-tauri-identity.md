# ADR: Optional Clerk Identity for Tauri Desktop

Date: 2026-07-04

Status: Accepted for spike, gated before production enablement

## Context

Fable is local-first. A Fable account must not be required for local files,
memory, schedules, connector OAuth, BYOK model providers, or solo workspaces.
Future cloud and team features still need a durable identity architecture that
can survive restart, revocation, optional organization selection, and future
Convex compatibility.

Clerk now exposes OAuth/OIDC authorization server metadata from the Clerk
Frontend API URL with authorization, token, JWKS, refresh-token, and public
client support. Clerk documents public OAuth clients as PKCE-only and exposes
JWKS for manual JWT verification. Tauri v2 supports system-browser flows through
ordinary OS URL openers and either loopback callbacks or deep links. The desktop
app already has a hardened loopback OAuth receiver and keyring-backed token
boundaries for connectors and model keys, so identity should follow that shape
without reusing connector OAuth or the confidential auth broker.

Primary references:

- Clerk OAuth/OIDC metadata and public-client PKCE:
  https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth
- Clerk manual JWT verification and JWKS:
  https://clerk.com/docs/guides/sessions/manual-jwt-verification
- Clerk session tokens and custom claims:
  https://clerk.com/docs/guides/sessions/session-tokens
- Clerk + Convex integration:
  https://clerk.com/docs/guides/development/integrations/databases/convex
- Tauri deep links:
  https://v2.tauri.app/plugin/deep-linking/
- Tauri opener:
  https://v2.tauri.app/reference/javascript/opener/
- Community Clerk Tauri plugin:
  https://github.com/Nipsuli/tauri-plugin-clerk
- Clerk OAuth organization selection:
  https://clerk.com/changelog/2026-05-14-oauth-organizations

## Threat Model

Assets:

- Local files, imported knowledge, memory, schedules, connector cache, and
  local workspace data.
- BYOK model credentials and connector OAuth credentials.
- Optional Clerk refresh/session credentials.
- Future cloud/team data and organization claims.

Trust boundaries:

- React to Rust Tauri commands.
- Rust to OS keyring.
- Rust to Clerk authorization, token, userinfo, and JWKS endpoints.
- Clerk identity to future Fable cloud APIs or Convex.
- Optional cloud identity to connector OAuth and the auth broker.

Attacker-controlled inputs:

- OAuth callback query parameters, including duplicate state/code/error values.
- Browser-launched loopback HTTP requests.
- Deep-link command line arguments, if a future build enables deep links.
- Network errors, stale JWKS, token refresh failures, and revoked sessions.
- JWT claims, including issuer, audience, authorized party, expiry, and
  organization context.

Required invariants:

- Signed-out and offline users keep local files, memory, schedules,
  connectors, BYOK models, and solo workspaces.
- Clerk identity cannot authorize connector actions and cannot reuse connector
  OAuth token storage.
- The auth broker remains only for confidential connector OAuth.
- System browser only; no embedded auth webview.
- Refresh/session credentials stay behind Rust and the OS keyring.
- React receives status, display identity, expiry, and org metadata only.
- Missing Clerk config disables the feature instead of creating a partial flow.

## Decision

Use Clerk OAuth Application public-client Authorization Code + PKCE, opened in
the system browser, with a loopback callback in the Tauri desktop runtime.

The spike adds a new Rust module, `clerk_identity`, with a dedicated keyring
service (`com.fable.workspace.identity.clerk`) separate from:

- `com.fable.workspace` for BYOK model keys.
- `com.fable.workspace.connectors` for connector OAuth tokens.
- `com.fable.workspace.vault` for the encrypted local database master key.

The React runtime receives only `IdentityStatus`:

- enabled/disabled state
- signed-in/signed-out/offline/revoked/error/needs-organization state
- issuer, audience, scopes, expiry
- display identity and selected organization metadata

It never receives access tokens, ID tokens, refresh tokens, PKCE verifiers,
JWKS cache, or Clerk secrets.

## Validation Rules

The Rust boundary must:

- Discover Clerk OAuth metadata from
  `FABLE_CLERK_ISSUER/.well-known/oauth-authorization-server`.
- Require HTTPS issuer, authorization, token, JWKS, and userinfo endpoints.
- Generate high-entropy state and PKCE S256 verifier/challenge values.
- Store pending state and verifier only in the identity keyring service.
- Enforce exact callback redirect scheme, host, port, and path.
- Consume pending state before token exchange.
- Validate JWT header algorithm is RS256.
- Select the matching JWKS key by `kid`.
- Verify signature.
- Validate issuer, expiry, not-before, issued-at, audience, and authorized party
  where configured or present.
- Validate required/allowed organization claims when org support is enabled.
- Treat refresh failure as revoked/expired and clear the local identity session.
- Treat offline startup as `offline` instead of deleting local state.

## Compared Options

### 1. Clerk Public-Client OAuth/PKCE With Loopback or Deep Link

Accepted.

Pros:

- Uses Clerk's standards-based OAuth/OIDC surface.
- Requires no distributed client secret.
- Works with the system browser.
- Fits Fable's existing Rust/keyring boundary.
- Can request `user:org:read` so Clerk presents org selection and emits `org_id`.
- Keeps React free of persisted auth secrets.
- Future cloud APIs and Convex can validate Clerk JWTs by issuer/JWKS.

Loopback is preferred for this spike because development is deterministic and it
matches the existing connector OAuth receiver. Deep links remain a production
packaging option but need single-instance handling and strict URL validation,
because Tauri documents that Windows/Linux can deliver deep links as command
line arguments and warns that users can manually trigger fake deep links.

### 2. Community Tauri Clerk Plugin

Rejected for Fable's production boundary, useful as reference only.

The plugin is community maintained and integrates Clerk JS into Tauri by using
Tauri HTTP/store plugins and patching global fetch for Clerk request routing. It
also documents optional persisted auth state through Tauri Store.

This conflicts with Fable's preferred boundary:

- It couples identity to Clerk JS state inside the renderer.
- It uses a broad HTTP permission example (`https://*`) that does not match the
  current CSP/no-provider-egress webview posture.
- It persists auth state outside Fable's dedicated Rust keyring design.
- It would add a second auth runtime instead of using the existing Rust command
  boundary.

### 3. Hosted Auth Page Plus One-Time Desktop Device-Link Exchange

Rejected for this spike; possible future fallback if Clerk public-client OAuth
is not enough.

This would send the user to a hosted Fable web page, authenticate with Clerk
there, and return a short-lived one-time desktop code to the app. It can be
strong if Fable owns a small cloud service that mints device sessions, validates
Clerk server-side, and exchanges a nonce-bound code with the desktop.

It is not the smallest production-honest route now:

- It requires a new Fable cloud exchange service before the desktop can sign in.
- It adds new server-side secret custody.
- It resembles a custom device flow but Clerk's public docs do not currently
  present a first-class OAuth device authorization grant for this use case.
- It would move identity launch sequencing ahead of the local-first desktop
  product.

## Required Clerk Configuration

Set these only in developer or deployment configuration, never in committed
source:

- `FABLE_CLERK_ISSUER`: Clerk Frontend API URL, for example
  `https://verb-noun-00.clerk.accounts.dev` or
  `https://clerk.example.com`.
- `FABLE_CLERK_OAUTH_CLIENT_ID`: Clerk OAuth Application public client id.
- `FABLE_CLERK_AUDIENCE`: expected JWT audience. Defaults to the client id for
  the spike, but production should set it explicitly.
- `FABLE_CLERK_AUTHORIZED_PARTY`: optional expected `azp`; production should
  set this when Clerk emits `azp`.
- `FABLE_CLERK_SCOPES`: optional scope list. Defaults to
  `openid profile email`.
- `FABLE_CLERK_REQUEST_ORG=true`: request `user:org:read` and show Clerk's
  organization selector when enabled.
- `FABLE_CLERK_REQUIRE_ORG=true`: require an `org_id` claim.
- `FABLE_CLERK_ALLOWED_ORG_IDS`: optional comma/space separated allowlist of
  organization ids.

The Clerk OAuth app must allow the loopback callback pattern used by the desktop
runtime. For packaged production builds, revisit whether to keep loopback or add
verified deep links with single-instance handling.

## Convex Compatibility

Convex can validate Clerk auth using the Clerk issuer/Frontend API URL and JWT
claims. Fable should not pass desktop refresh tokens to Convex. Future Convex
integration should request or mint short-lived Clerk JWTs appropriate for Convex,
validate issuer and audience server-side, and map organization claims only when
team features are active. The desktop's identity boundary is compatible with
that direction because it already treats identity as optional status plus
short-lived validated tokens behind Rust.

## Remaining Risks and Gates

- Confirm exact Clerk OAuth access-token and ID-token claim shapes in a live dev
  instance before enabling production config.
- Decide whether production packaging should remain loopback or use deep links
  with Tauri single-instance support.
- Add platform CI for Windows Credential Manager, macOS Keychain, and Linux
  Secret Service identity flows.
- Decide whether sign-out should call a server-side token revocation route.
  Clerk documents Backend API OAuth token revocation, but this desktop spike
  intentionally does not embed a Clerk secret.
- Add a real cloud API/Convex verifier before any team data is unlocked by this
  identity.
- Keep the feature disabled in release builds until the Clerk app, callback
  allowlist, org policy, audience, and authorized party are explicitly set.
