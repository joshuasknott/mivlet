# ADR: durable ephemeral storage for the OAuth broker

- Status: accepted
- Scope: `apps/broker`

## Decision

The confidential connector OAuth broker stores only short-lived pending
authorization exchanges, single-use desktop handoff tickets, and rate-limit
state. Local development and deterministic tests may keep this state in one
process. Staging and production must use the encrypted Durable Object backend
declared in `apps/broker/wrangler.jsonc`.

Memory storage is refused when `FABLE_BROKER_PUBLIC_URL` is public HTTPS
(HTTPS and not loopback). Unlabeled or `local` Workers with a public URL fail
closed (503), even if durable storage is selected. Staging and production
still require durable bindings and `FABLE_BROKER_STORE_ENCRYPTION_KEY`.
Long-lived user tokens are returned once to the native desktop credential
boundary and are not retained by the broker.

## Required properties

- Authorization state is high entropy, expires, binds the provider and exact
  desktop redirect, and is consumed before token exchange.
- Handoff tickets expire, bind the original state, and can be redeemed once.
- Durable values are encrypted with versioned associated data; plaintext
  tokens, verifiers, client secrets, and redirects never enter logs.
- Rate limits are shared across Worker isolates and keyed by route and a derived
  peer value.
- Broker callbacks accept only the exact registered provider and the original
  loopback or allowlisted HTTPS desktop redirect.
- Storage failures, malformed records, replays, provider mismatches, and missing
  configuration fail closed.

## Consequences

Memory storage is useful for local tests but cannot support a multi-isolate
deployment claim. A Wrangler dry-run proves configuration and packaging only.
A live release still requires provider-console callback registration, deployed
secrets and bindings, concurrent callback/replay testing, log inspection, and
revocation testing against configured provider applications.

The broker remains separate from Fable accounts, model-provider
credentials, workspace data, and optional sync services.
