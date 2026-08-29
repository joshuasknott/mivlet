# Workspace data model

The durable local ownership root is a workspace. Fable currently prepares a
stable local workspace during onboarding; future account or collaboration code
must not replace that local authority implicitly.

## Current relationships

- A project is optional context inside one workspace. Conversation does not
  require a project.
- A thread belongs to one workspace and may point to one project.
- Messages and their immutable revisions belong to a thread.
- A `run` row is an internal execution attempt for one provider turn. It exists
  for interruption, cancellation, approval binding, and safe retry; it is not a
  top-level product object or navigation destination.
- Tool calls and approvals bind to the exact execution attempt that proposed
  them.
- Knowledge and memory belong to one workspace and may use optional project or
  thread context where their repository supports it.
- Provider and plugin-style Connection metadata belongs to a workspace, while
  the associated credential stays behind its own secure boundary.
- A local teammate computer is derived from the exact workspace and teammate
  identity. Its Docker volume and scoped file bridge are not general workspace
  database records.

## Isolation rules

1. Every user-owned query starts with an explicit validated workspace.
2. A project scope is accepted only when that project belongs to the same
   workspace.
3. Missing or invalid scope never falls back to the active, default, or only
   workspace.
4. Writes check existing record ownership before mutation, preventing an ID
   from being claimed through another workspace.
5. Credentials, vault keys, approval permits, browser profiles, container
   identifiers, and host paths never become portable workspace records.
6. Optional remote writes remain pending until a remote boundary rechecks
   current identity, workspace authority, and device eligibility.

The `default` workspace ID is local compatibility state, not an authentication
or remote-tenancy rule.

## Repository guidance

Use the native `DataScope` and the existing ownership helpers for scoped
repositories. Workspace-only repositories must reject project scope explicitly.
Queries must include their workspace predicate or prove ownership before using a
global opaque ID. Cross-workspace delete attempts should reveal no record
existence.

When adding a record, document its authority, optional context, AAD identity,
tombstone or cascade behavior, credential treatment, backup/export behavior,
and whether it is eligible for any future remote allowlist.
