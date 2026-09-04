# Account-first onboarding

Date: 2026-08-31

Status: Accepted

## Decision

Fable's first-run journey is account sign-in, model-provider connection, then
optional app connectors. Google is the primary account entry point and email is
the quiet secondary method; each method can sign in or create an account. At
least one model provider must be verified before the journey can finish.

Fable creates the default Chief of Staff in local state before first run, but
does not mention or configure that teammate during onboarding. The teammate
appears when the person enters the conversation workspace after setup.

## Connection hierarchy

Provider families are selected with icon-only controls that retain accessible
names. Where an officially supported account sign-in exists, it is the primary
action and the API-key path is secondary. The quiet first view shows ChatGPT,
Claude, Google, and Grok; Cursor, OpenCode, and custom connections live behind
the expanded catalogue. Providers without a runnable account driver show the
available API-key path or an honest install-required state. Provider secrets
remain outside React state after submission and cross through the existing
native credential boundary.

Connector setup is optional. Each connector uses its existing OAuth boundary;
skipping the screen neither fabricates a connection nor weakens later approval
checks.

## Local-first boundary

Account identity gates first-run setup but does not become the authority for
local conversations, encrypted workspace records, provider credentials,
connector credentials, approvals, or the local teammate computer. Those remain
device-local. Remote synchronization and collaboration stay separately gated
and cannot be inferred from a successful account sign-in.

Missing identity configuration fails closed with a plain-language message.
Browser preview state remains explicitly synthetic and is not evidence of a
deployed sign-in or connector integration.

The first-run privacy disclosure describes the current local storage, account,
provider, and connector boundaries inside Fable. It does not link to an
unverified public domain or claim agreement to an unpublished legal policy.
The shared screen walkthrough is available in development at
`/design-preview.html?view=onboarding`; its connections are simulated.
