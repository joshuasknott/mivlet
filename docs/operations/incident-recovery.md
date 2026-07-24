# Local incident and recovery guide

This guide covers repository-supported local evidence. It does not replace
provider, Clerk, Convex, OAuth, signing, or hosting incident procedures.

## First response

1. Stop the affected Mission or pause the affected Routine or Schedule from its
   product surface. Do not retry an unknown consequential effect.
2. Open Settings → Privacy → Local health check. Record category state and
   counts only; the report intentionally excludes content, paths, credentials,
   account identifiers, prompts, and provider responses.
3. Preserve the current app-data directory and any `pre-restore`,
   `failed-restore`, or pending-restore database files before attempting repair.
4. Export the affected workspace when the encrypted database can still open.
5. Revoke the exact provider, Connection, MCP server, account device, or grant
   implicated by the evidence. Reconnect only after the cause is understood.

## Recovery order

Use the least destructive path:

1. retry only a repository-classified transient operation with its saved
   budget and idempotency evidence;
2. restart so expired leases and interrupted runs use their bounded recovery
   paths;
3. use exact rollback for an unchanged migrated Routine where supported;
4. stage a verified encrypted backup restore and restart;
5. import a portable workspace export when the original vault key is
   unavailable.

Raw SQLite backup restore requires the same OS-held vault key. Provider and
OAuth credentials are never inside that backup. A wrong key, corrupt candidate,
newer schema, linked file, or unmarked database fails before the live database
is replaced. Startup preserves the prior database and rolls back if opening or
migration fails.

## Evidence to retain

- source commit and application version;
- release manifest and installer SHA-256;
- secret-free Local health check states/counts;
- affected Run, Routine, Connection, or MCP display reference;
- exact time window and user-visible failure;
- whether an external effect may have occurred;
- backup/export identity and restore outcome;
- revocations performed and the reason for reopening execution.

Never copy credentials, tokens, raw prompts, external content, database keys,
or decrypted database rows into support notes.

## Escalation boundaries

Repository evidence cannot prove provider-side effects, hosted account state,
OAuth revocation, multi-account consistency, certificate compromise, updater
publication, or public-download integrity. Those require their owning console,
live account, signing system, or hosting service and must remain explicitly
unresolved until checked there.
