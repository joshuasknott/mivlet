# ADR: MCP OAuth client registration order

- Status: Accepted
- Date: 2026-07-11
- Scope: Remote MCP authorization for Fable Desktop

## Decision

Fable follows the MCP 2025-11-25 client-registration preference order and remains an OAuth public client:

1. Use issuer-specific pre-registered client information when Fable has an exact configured match.
2. Otherwise use a Client ID Metadata Document when the authorization server advertises support and Fable has a configured public HTTPS metadata document.
3. Otherwise use Dynamic Client Registration when the authorization server publishes a registration endpoint.
4. Otherwise require explicit manual client information in advanced setup.

Every strategy uses Authorization Code with PKCE S256. Fable will not embed, infer, log, or return a client secret. Client registration never grants a capability, enables an MCP tool, selects a workspace, or satisfies an exact-action approval.

The implementation reports the selected strategy after validating protected-resource and authorization-server metadata. Issuer-specific pre-registration is configuration-gated by `FABLE_MCP_OAUTH_PREREGISTERED_CLIENTS`, a bounded JSON object whose exact canonical issuer keys map to public client IDs. Client ID Metadata Documents are configuration-gated by `FABLE_MCP_OAUTH_CLIENT_METADATA_DOCUMENT_URL`, which must be a credential-free public HTTPS URL without a query or fragment. Malformed configuration fails closed instead of silently falling through to a weaker registration route.

## Rationale

Pre-registration gives the strongest operator control and best compatibility where a private Fable deployment has arranged it. Client ID Metadata Documents avoid per-server registration while preserving verifiable public metadata, but require Fable to operate an HTTPS document with exact redirect URIs; repository code must not pretend that external resource exists. Dynamic Client Registration is the interoperable zero-touch fallback for servers that support it. Manual information remains last because it increases setup and configuration-error risk, but it is necessary for servers supporting none of the automated options.

This order fits Fable's private-product direction: account connection stays an advanced secondary flow, server-specific compatibility does not become a public marketplace, and no external resource or credential is created by repository work.

## Consequences and evidence gates

- The repository can choose and explain a registration route without exposing client identifiers to React.
- A configured metadata-document route is not considered live until the HTTPS document and exact redirect contract exist externally.
- Dynamic registration, loopback callback handling, token exchange, refresh/revocation, OS credential custody, authenticated MCP requests, and third-party interoperability remain separate evidence gates.
- The normative basis is the official [MCP 2025-11-25 authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
