# Product direction

Mivlet is a calm, local-first workspace where a person works with named AI
teammates through ordinary conversation. Mivlet supplies permitted context,
uses only connected providers and tools, pauses at consequential boundaries,
and leaves an inspectable local record.

This is direction rather than a capability checklist. The root `README.md` is
the concise source of truth for repository maturity.

## Default experience

1. Sign in to Mivlet to open the local workspace.
2. Choose a named teammate and connect a supported model provider before running work.
3. Describe the work in conversation.
4. Watch the current work, stop application control when needed, and
   approve exact consequential actions.
5. Continue refining the result in the same conversation.

Memory, Plugins, approvals, model choice, and computer controls are
contextual depth. They should not become permanent navigation clutter or make a
person administer execution machinery.

## Capability direction

- Provider-neutral model selection through Mivlet-owned contracts.
- Durable teammate identity, responsibilities, context, and conversation.
- Native Windows application control in the user's existing session, with exact
  target selection and immediate Stop. This is not an isolated local desktop.
- Optional isolated hosted computers only when the person intentionally chooses
  remote placement and the deployment is available.
- Scoped workspace files, app integrations and MCP tools that are observable and
  approval-bound. Browser interaction depends on the available execution route;
  passive web previews do not establish browser automation.
- Account sign-in for first-run setup, with workspace data and provider
  credentials remaining local. Future synchronization is separately gated.

## Trust model

- Credentials remain behind native or deployment-secret boundaries.
- External content and tool output are untrusted input.
- Consequential actions bind the exact service, action, scope, preview,
  freshness, and single-use authority immediately before execution.
- Local and hosted computers have separate, explicit trust boundaries.
- Fixtures, simulations, tests, and dry-runs stay labelled.
- People can inspect action history, stop work, change authority, disconnect
  services, and remove retained knowledge or memory.

## Product qualities

Mivlet should feel direct, quiet, and capable. Prefer progressive disclosure,
plain language, strong defaults, compact accessible controls, and honest failure
states. Infrastructure is successful when it makes conversation simpler.

## Current boundary

The repository implements a local Windows desktop foundation, encrypted local
data, provider and Connection boundaries, approvals, and native Windows
application control through global approvals and immediate Stop. Full Access adds no per-app grants. First-run account sign-in requires configured identity;
hosted computer/browser and synchronization remain optional and deployment-gated.
Production hosted operation, secure
hosted sign-in, ordinary conversation continuation after close, multi-device
sync, mobile control, and multi-platform releases remain incomplete.
