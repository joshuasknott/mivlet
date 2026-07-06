# Auth broker live-certification deployment runbook

Status: live-certification staging. This runbook prepares the Cloudflare Worker
used for Batch 5 provider certification of the confidential OAuth broker. It
does not enable production.

## Deployment boundary

- Live-certification Worker name: `fable-auth-broker`.
- Public origin: `https://fable-auth-broker.joshhknott.workers.dev/`.
- Production Worker name is declared as `fable-auth-broker-production` for review
  only. Do not deploy production in Batch 4.
- The broker remains a confidential OAuth broker only. Do not add connector API,
  model, search, import, prompt, or provider-content proxy routes.
- Local/default Worker dev uses memory storage. Staging and production must use
  Durable Object storage.

## Required non-secret staging vars

Set these as Wrangler vars or Cloudflare dashboard Worker variables:

| Name | Staging value |
| :--- | :--- |
| `FABLE_BROKER_ENVIRONMENT` | `staging` |
| `FABLE_BROKER_STORAGE_BACKEND` | `durable` |
| `FABLE_BROKER_RATE_LIMIT_PER_MINUTE` | `60` unless explicitly changed |
| `FABLE_BROKER_PUBLIC_URL` | `https://fable-auth-broker.joshhknott.workers.dev/` |
| `FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS` | Optional exact HTTPS desktop callbacks; loopback callbacks are built in |

`FABLE_BROKER_PUBLIC_URL` is not an OAuth secret, but it is
environment-specific. Keep placeholders out of real deploys because provider
callback URLs are derived from this value.

## Required staging secrets

Set these with `wrangler secret put --env staging`. Never commit real values.

| Name | Requirement |
| :--- | :--- |
| `FABLE_BROKER_STORE_ENCRYPTION_KEY` | 32 random bytes encoded as unpadded base64url |
| `FABLE_BROKER_GITHUB_CLIENT_ID` | Staging GitHub OAuth App client id |
| `FABLE_BROKER_GITHUB_CLIENT_SECRET` | Staging GitHub OAuth App client secret |
| `FABLE_BROKER_VERCEL_CLIENT_ID` | Staging Vercel integration client id |
| `FABLE_BROKER_VERCEL_CLIENT_SECRET` | Staging Vercel integration client secret |
| `FABLE_BROKER_LINEAR_CLIENT_ID` | Staging Linear OAuth client id |
| `FABLE_BROKER_LINEAR_CLIENT_SECRET` | Staging Linear OAuth client secret |
| `FABLE_BROKER_NOTION_CLIENT_ID` | Staging Notion OAuth client id |
| `FABLE_BROKER_NOTION_CLIENT_SECRET` | Staging Notion OAuth client secret |
| `FABLE_BROKER_SLACK_CLIENT_ID` | Staging Slack app client id |
| `FABLE_BROKER_SLACK_CLIENT_SECRET` | Staging Slack app client secret |

Providers are disabled by omission: if a provider id/secret pair is absent, that
provider fails closed with `configuration-required`. This is the preferred
staging enable/disable switch before provider certification.

Generate the store key locally:

```bash
node -e "const b=crypto.getRandomValues(new Uint8Array(32)); console.log(Buffer.from(b).toString('base64url'))"
```

## Local validation before Cloudflare

Run from the repository root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @fable/protocol build
corepack pnpm --filter @fable/connectors build
corepack pnpm --filter @fable/broker typecheck
corepack pnpm --filter @fable/broker test
corepack pnpm --filter @fable/broker exec wrangler deploy --config wrangler.jsonc --env staging --dry-run --keep-vars --var FABLE_BROKER_PUBLIC_URL:https://fable-auth-broker.joshhknott.workers.dev/
```

The dry-run bundles the staging env but does not upload. It validates the Worker
entrypoint, Durable Object bindings, and migration declarations as far as the
local Wrangler toolchain permits.

## Cloudflare login and account selection

```bash
corepack pnpm --filter @fable/broker exec wrangler login
corepack pnpm --filter @fable/broker exec wrangler whoami
```

Confirm the account is the intended staging account before setting secrets or
deploying. If multiple accounts are available, add the selected account id to
`apps/broker/wrangler.jsonc` only after confirming it is not sensitive for this
repo, or pass the account selection through the Wrangler session.

## DNS and callback setup

1. Use the existing live-certification origin
   `https://fable-auth-broker.joshhknott.workers.dev/`.
2. Register provider callback URLs exactly:
   `https://fable-auth-broker.joshhknott.workers.dev/oauth/<provider>/callback`.
3. Keep production provider apps separate from these certification provider apps.

Do not deploy with a placeholder `FABLE_BROKER_PUBLIC_URL`.

## Durable Object migration state

Wrangler config declares one SQLite-backed migration:

```text
v1-broker-ephemeral:
  BrokerPending
  BrokerHandoff
  BrokerRateLimit
```

The migration is applied by the first real durable deploy for that environment.
Rollback can move Worker code to an older version, but Durable Object class
migrations are not generally undone. The stored rows are ephemeral and expire in
about 60 seconds, but the class declarations remain account state.

## Set staging secrets

From `apps/broker` or with `--filter @fable/broker exec`:

```bash
wrangler secret put FABLE_BROKER_STORE_ENCRYPTION_KEY --env staging
wrangler secret put FABLE_BROKER_GITHUB_CLIENT_ID --env staging
wrangler secret put FABLE_BROKER_GITHUB_CLIENT_SECRET --env staging
wrangler secret put FABLE_BROKER_VERCEL_CLIENT_ID --env staging
wrangler secret put FABLE_BROKER_VERCEL_CLIENT_SECRET --env staging
wrangler secret put FABLE_BROKER_LINEAR_CLIENT_ID --env staging
wrangler secret put FABLE_BROKER_LINEAR_CLIENT_SECRET --env staging
wrangler secret put FABLE_BROKER_NOTION_CLIENT_ID --env staging
wrangler secret put FABLE_BROKER_NOTION_CLIENT_SECRET --env staging
wrangler secret put FABLE_BROKER_SLACK_CLIENT_ID --env staging
wrangler secret put FABLE_BROKER_SLACK_CLIENT_SECRET --env staging
```

Only set provider secrets that are ready for staging certification. Missing
providers remain disabled.

## Staging deploy

After local validation and secret setup:

```bash
corepack pnpm --filter @fable/protocol build
corepack pnpm --filter @fable/connectors build
corepack pnpm --filter @fable/broker exec wrangler deploy --config wrangler.jsonc --env staging --keep-vars --var FABLE_BROKER_PUBLIC_URL:https://fable-auth-broker.joshhknott.workers.dev/
```

`--keep-vars` prevents Wrangler from deleting dashboard-managed staging vars
that are intentionally absent from source.

## Smoke checks

```bash
curl -fsS https://fable-auth-broker.joshhknott.workers.dev/healthz
```

Expected with no provider credentials: HTTP 200 with an empty `providers` list.
Expected with selected provider credentials: only configured providers appear.

For each enabled provider in Batch 5:

1. Start OAuth from a staging desktop pointed at the staging broker.
2. Confirm callback success and handoff redemption.
3. Replay the callback URL and confirm `invalid-state`.
4. Wait longer than 60 seconds before redeeming a handoff and confirm
   `invalid-handoff`.
5. Confirm refresh and revoke behavior matches that provider's documented flow.

## Logs and metrics

Safe logs include route path, event name, and correlation id. Logs must not
include tickets, authorization codes, tokens, refresh tokens, PKCE verifiers,
state values, client secrets, raw provider bodies, account identifiers, prompts,
or provider content.

Review:

```bash
wrangler tail fable-auth-broker --env staging
```

Search logs and analytics exports for:

```text
access_token
refresh_token
client_secret
authorization:
Bearer
code=
handoff=
state=
```

Any hit is an incident unless it is a redacted literal.

## Secret rotation

Provider credential rotation:

1. Create the replacement credential in the staging provider console.
2. Run `wrangler secret put <NAME> --env staging`.
3. Redeploy or roll a new Worker version if needed by the platform.
4. Re-run provider smoke tests.
5. Delete the old provider credential in the provider console.

Store encryption key rotation:

1. Because broker durable rows expire in about 60 seconds and the current code
   has one active store key, pause new staging OAuth starts.
2. Wait at least 120 seconds for pending exchanges and handoffs to expire.
3. Replace `FABLE_BROKER_STORE_ENCRYPTION_KEY`.
4. Resume staging OAuth and re-run smoke tests.

## Rollback

Code rollback:

```bash
wrangler deployments list --env staging
wrangler rollback --env staging
```

Rollback limitations:

- Durable Object migrations are account state and should be treated as forward
  only.
- Rolling back to memory storage is possible by deploying a Worker version with
  `FABLE_BROKER_STORAGE_BACKEND=memory`, but staging/production code now fails
  closed when `FABLE_BROKER_ENVIRONMENT` is `staging` or `production` and the
  backend is not `durable`.
- In-flight OAuth attempts may fail during rollback. Users should restart OAuth.

## Expected latency and failure modes

Expected additional latency is one Durable Object operation for authorize, one
for callback pending consumption, one for handoff issue, one for handoff redeem,
and rate-limit checks per OAuth route. Cross-region callbacks can add noticeable
edge-to-object latency but should remain within normal OAuth redirect tolerance.

Common failures:

| Failure | Expected response | Operator action |
| :--- | :--- | :--- |
| Missing store key | `configuration-required`, 503 | Set `FABLE_BROKER_STORE_ENCRYPTION_KEY` |
| Invalid store key length | `configuration-required`, 503 | Regenerate 32-byte base64url key |
| Missing DO binding/migration | deploy failure or 503 | Check env bindings and migration tag |
| Missing provider credentials | `configuration-required`, 503 for that provider | Set or intentionally leave disabled |
| Callback replay | `invalid-state`, 400 | No action unless repeated abuse |
| Handoff replay/expiry | `invalid-handoff`, 400 | User restarts OAuth |
| Provider 429 | `rate-limited`, 429 | Back off and inspect provider limits |
| Provider outage | `provider-unavailable`, 502 | Retry later or disable provider |

## Incident response and disable switch

Immediate disable options:

1. Remove or rotate the affected provider secret pair. The provider fails closed.
2. Roll back to the previous safe Worker version.
3. Disable the Worker route/custom domain in Cloudflare if broad compromise is
   suspected.
4. Revoke compromised provider app credentials in the provider console.

Do not collect raw provider response bodies or token payloads during incident
debugging. Use correlation ids, provider audit logs, and Cloudflare metadata.
