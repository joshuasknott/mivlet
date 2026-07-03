# @fable/waitlist

Isolated Cloudflare Worker for the Fable waitlist. **Never shares routes, DB, or state with apps/broker.**

## Local development

```sh
pnpm --filter @fable/waitlist dev
# or
pnpm waitlist:dev
```

## D1 local migrations

```sh
pnpm waitlist:migrate
# applies to local sqlite under .wrangler
```

## Turnstile local test configuration (documented, per spec)

For local dev and deterministic tests we use Cloudflare's **always-pass** test keys (no network call required for happy path in dev).

- Site key (frontend widget): `1x00000000000000000000AA` (always passes, visible)
- Secret key (server verify): `1x0000000000000000000000000000000AA` (always passes)

In production, replace with real keys via `wrangler secret put TURNSTILE_SECRET`.

**Never commit real secrets.** The test keys are public per Cloudflare docs and safe for local/CI.

To force Turnstile failure locally: send an invalid token in the form.

When `TURNSTILE_SECRET` is not set or equals the test secret, the Worker accepts the known test tokens without calling the remote endpoint (for offline testability). Real verification is always performed when a non-test secret is present.

## Rate limits (local)

See wrangler.jsonc vars. In-memory fixed window.

## Never-log invariants

The Worker and tests assert that raw emails, tokens, IPs, and full form bodies are never written to logs. Redaction + hash-only storage.

## Broker isolation

See tests for contract proving no waitlist paths leak into broker router.
