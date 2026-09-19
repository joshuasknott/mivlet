# Mivlet account pages

The browser account surface for the native desktop's existing Clerk OAuth flow.
It uses Clerk's maintained SignIn, SignUp and OAuthConsent components with one
Mivlet theme, including their password, recovery, verification and MFA states.
It has no native IPC, workspace access, server secret or account-token bridge.
The native app still owns OAuth state, PKCE and the loopback callback.

## Local development

Copy `.env.example` to `.env.local` and set the public key for the desktop's
existing Clerk instance, plus `VITE_CLERK_ISSUER` and
`VITE_CLERK_OAUTH_CLIENT_ID` from the desktop configuration. Then run
`pnpm --filter @mivlet/accounts dev`.
Open `/sign-in`, `/sign-up` or `/oauth-consent` (the last requires a real signed-in
OAuth request). Missing configuration fails closed. `/complete` resumes a validated desktop authorization saved in this tab. Without
one, it explains that browser sign-in alone does not authorize a native workspace.

Run `pnpm --filter @mivlet/accounts build` and `pnpm --filter @mivlet/accounts test`.

When `apps/accounts/.env.local` exists, `pnpm tauri:dev` starts this site on
`127.0.0.1:1421` alongside the desktop and sets the native account entry URL.
Do not run a second account dev server on that port at the same time.

Desktop Log in and Sign up enter `/desktop/start` with their distinct mode and
the native-generated OAuth request. This route validates the issuer, client,
PKCE parameters and literal loopback callback. An existing browser session
offers Continue with this account or an explicit account switch; only switching
ends that session. Switching forms and verification callbacks preserve the
validated authorization in tab-scoped storage for at most five minutes, without
extending its lifetime on reload. Tokens are still exchanged
and validated by the native process, not by this page.

## Connecting the account site

Build and host `dist` with SPA fallback to `index.html`, HTTPS, no analytics on
authentication routes, and the response headers in `public/_headers` (or their
hosting-platform equivalents). Use a domain under the same registrable domain
as the production Clerk instance. Keep the Clerk Account Portal enabled as a
fallback until the new flow is verified.

Set `MIVLET_CLERK_ACCOUNT_ENTRY_URL=https://<account-host>/desktop/start` in the
desktop launch/build environment. Production refuses HTTP entry URLs. Without
this setting, Log in uses Clerk's supported `consent` prompt; Sign up
reports the missing account-site configuration instead of silently logging in.
The local development site is not a published authentication service.

In the **same Clerk instance** used by the native app, configure Paths to use
the new host for Sign in (`/sign-in`), Sign up (`/sign-up`) and OAuth consent
(`/oauth-consent`). Configure the development host separately when testing.
Keep OAuth application consent enabled. Start an actual native request and
verify both Allow and Cancel and the return to the native loopback callback.
Do not hardcode OAuth query parameters, scopes, identities or redirect URLs in
the page. The validated desktop entry preserves `authorization_url` separately
and supplies it through the form's post-authentication redirect props. Do not
put the OAuth endpoint in `redirect_url`: Clerk can enter OAuth immediately
and replace the selected registration form with its hosted sign-in page.

The supported **Application settings → Branding → Remove “Secured by Clerk”**
setting controls branding; it is not hidden with CSS. This requires an eligible
production plan. The development-mode label is a Clerk environment indicator;
use production keys for production rather than disguising a development service.

Sources: [custom consent](https://clerk.com/docs/react/guides/configure/auth-strategies/oauth/custom-consent-page),
[branding](https://clerk.com/docs/react/reference/components/overview).
