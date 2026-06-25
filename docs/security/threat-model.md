# Threat Model

## Assets

- Local files and imported knowledge.
- Credentials in OS secure storage.
- Durable memory and user preferences.
- Approval audit history.
- Connector tokens and external service data.
- Generated artifacts and published work.

## Trust Boundaries

- User interface to Rust runtime.
- Runtime to local filesystem.
- Runtime to external connectors.
- Runtime to Convex shared state.
- Model-generated content to trusted user action.

## Key Risks

- Prompt injection through imported documents or web content.
- Accidental publish/write/delete through a connector.
- Memory poisoning from untrusted or stale sources.
- Credential leakage through logs, screenshots, artifacts, or PRs.
- Lost state after restart during a pending approval.

## Controls

- Read-only, trusted-scope, and full-access modes.
- Consequence summaries before consequential actions.
- Approve once, session, rule, modify, and deny outcomes.
- Stronger confirmation for destructive, public, or financial actions.
- Memory provenance, freshness, permissions, and fact/inference separation.
- Connector health and permission review before execution.
