# Account-first onboarding

> Account-owned storage follows
> [the roadmap baseline contract](../development/roadmap-parallel-contract.md).
> The original installation-wide authority and mandatory provider setup were superseded.

Date: 2026-08-31

Status: Accepted

Updated 2026-09-15: authenticated accounts open their local workspace directly,
without replaying onboarding or requiring provider setup to enter the app.
Signed-out users authenticate first. A verified provider remains required for
agent execution.

## Decision

Mivlet's entry flow is account sign-in, then the account's local workspace.
Google is the primary account entry point and email is the quiet secondary
method; each can sign in or create an account. Provider setup and optional app
connections remain available inside the workspace. A verified provider is
required to execute an agent, not to enter the app.

Mivlet creates the default Chief of Staff in local state before first run, but
does not mention or configure that teammate during onboarding. The teammate
appears when the person enters the conversation workspace after sign-in.

## Connection hierarchy

Provider families use one display name and an icon-first, searchable catalogue.
All enabled providers appear together; only connected providers show a Connected label with each
name, and selecting a provider opens its connection modal. Where an officially
supported account sign-in exists, it is the primary action and the API-key path
is secondary. Providers without a runnable account driver show the
available API-key path or an honest install-required state. Provider secrets
remain outside React state after submission and cross through the existing
native credential boundary.

Settings contains General, Providers, Models, and Memory. There is no Knowledge
settings tab; imported files remain stored as knowledge sources and are managed
from Memory and project files. App connections and
custom tool servers are managed in Plugins. Model visibility is managed in Models. Providers has a secondary Add an API key
action; Custom provider, SiliconFlow, and Together are omitted from its catalogue.
Memory contains saved facts and their controls; backup, recovery, and privacy
information are not settings sections. Dictation is in General.

Connector setup is optional and lives in Plugins. Each connector keeps its
existing authorization boundary. Removing the old onboarding stages grants
neither a connection nor permission for later actions.

## Local-first boundary

Validated account identity selects a separate native store and credential profile.
Conversations and workspace records remain device-local, while credentials stay
behind native secure storage. Signing in supplies neither provider access nor
connector consent or computer permissions. Remote synchronization remains
separately gated and cannot be inferred from successful account sign-in.

Missing identity configuration fails closed with a plain-language message.
Browser preview state remains explicitly synthetic and is not evidence of a
deployed sign-in or connector integration.

The first-run privacy disclosure describes the current local storage, account,
provider, and connector boundaries inside Mivlet. It does not link to an
unverified public domain or claim agreement to an unpublished legal policy.
Verify this flow through the actual application entry point and focused account
tests; there is no separately maintained onboarding preview.
