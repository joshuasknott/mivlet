# Account-first onboarding

> Account-owned storage follows
> [the roadmap baseline contract](../development/roadmap-parallel-contract.md).
> The original installation-wide authority was superseded; provider setup remains required.

Date: 2026-08-31

Status: Accepted

Updated 2026-09-19: authenticated accounts must connect a usable AI provider
before entering the workspace. Returning accounts with a usable provider open
directly. Account login supports cancellation and retries without forcing a
second browser login. Provider navigation remains available while connecting.

## Decision

Mivlet's entry flow is Log in or Create an account, browser authentication,
then required provider setup and the account's local workspace. Google and
email authentication are available in the browser. Provider setup cannot be
skipped; optional app connections remain available inside the workspace.

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
existing authorization boundary. Navigating back through onboarding grants
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
