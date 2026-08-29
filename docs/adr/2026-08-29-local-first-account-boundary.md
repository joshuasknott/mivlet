# Local-first account boundary

Date: 2026-08-29

Status: Accepted

## Decision

Fable's usable product begins on the device. A person can prepare a local
workspace, connect a supported model provider, create a named teammate, and
work in conversation without creating a Fable cloud account.

An account is an optional boundary for capabilities that genuinely need remote
identity, such as future multi-device synchronization, shared workspaces, or a
deployed hosted computer. Account configuration must not gate local
conversations, local encrypted data, local provider connections, approvals, or
the Docker-backed local teammate computer.

## Authority

- Encrypted SQLite is authoritative for local workspace records.
- The operating-system credential store is authoritative for local provider,
  connector, identity-session, and vault secrets. Those credentials remain
  separate from one another.
- Fable protocol types define boundaries shared by React, Rust, Convex, and
  hosted services. Provider-specific behavior stays in adapters.
- Convex and Clerk code in this repository is optional foundation. It is not
  evidence of deployed synchronization, collaboration, account recovery, or
  production tenancy.
- A deployed remote boundary must derive the authenticated person server-side,
  verify current workspace membership and device eligibility, and apply the
  workspace scope before reading or changing data. Renderer assertions and
  cached roles are never authorization.

## Data movement

Remote synchronization is allowlist-based, record-specific, and off by
default. It must never copy vault keys, provider or connector credentials,
browser profiles, approval permits, local-computer state, raw connector caches,
or host paths. Queued remote writes are pending until the server accepts them
under current authority; reconnect does not revive stale authority.

The confidential OAuth broker remains a narrow connector authorization
component. It does not store waitlist data, become the product account backend,
proxy ordinary connector traffic, or receive model-provider credentials.

## Failure behavior

Missing account, Convex, Clerk, broker, or hosted-runner configuration leaves
the related optional capability unavailable with a plain-language explanation.
It must not disable local work or silently substitute fixtures. Production
claims require a deployed environment and live validation in addition to local
tests and packaging checks.

## Consequences

- Onboarding requires a validated model-provider connection, not a Fable
  account.
- Local and remote execution remain explicit placements with separate trust
  boundaries.
- Collaboration and multi-device synchronization remain future work until
  their product flow, authorization, recovery, retention, and live operation
  are implemented and verified.
- Historical account-required, organization-shaped, automation, and broad
  replication designs are retired rather than retained as competing sources of
  truth.
