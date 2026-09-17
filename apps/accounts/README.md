# Mivlet account pages

The browser account surface for the native desktop's existing Clerk OAuth flow.
It uses Clerk's maintained SignIn, SignUp and OAuthConsent components with one
Mivlet theme, including their password, recovery, verification and MFA states.
It has no native IPC, workspace access, server secret or account-token bridge.
The native app still owns OAuth state, PKCE and the loopback callback.

## Local development

Copy `.env.example` to `.env.local` and set the public key for the desktop's
existing Clerk instance. Then run `pnpm --filter @fable/accounts dev`.
Open `/sign-in`, `/sign-up` or `/oauth-consent` (the last requires a real signed-in
OAuth request). Missing configuration fails closed. `/complete` tells users to
return to the desktop; it does not claim that a native workspace was authorized.

Run `pnpm --filter @fable/accounts build` and `pnpm --filter @fable/accounts test`.

## Connecting the account site

Build and host `dist` with SPA fallback to `index.html`, HTTPS, no analytics on
authentication routes, and the response headers in `public/_headers` (or their
hosting-platform equivalents). Use a domain under the same registrable domain
as the production Clerk instance. Keep the Clerk Account Portal enabled as a
fallback until the new flow is verified.

In the **same Clerk instance** used by the native app, configure Paths to use
the new host for Sign in (`/sign-in`), Sign up (`/sign-up`) and OAuth consent
(`/oauth-consent`). Configure the development host separately when testing.
Keep OAuth application consent enabled. Start an actual native request and
verify both Allow and Cancel and the return to the native loopback callback.
Do not hardcode OAuth query parameters, scopes, identities or redirect URLs in
the page. Do not override SDK force-redirect URLs: the pending OAuth flow must
retain its own continuation.

The supported **Application settings → Branding → Remove “Secured by Clerk”**
setting controls branding; it is not hidden with CSS. This requires an eligible
production plan. The development-mode label is a Clerk environment indicator;
use production keys for production rather than disguising a development service.

Sources: [custom consent](https://clerk.com/docs/react/guides/configure/auth-strategies/oauth/custom-consent-page),
[branding](https://clerk.com/docs/react/reference/components/overview).
