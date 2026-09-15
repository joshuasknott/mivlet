# Google models through Antigravity ACP

Date: 2026-09-03

Status: Accepted

## Decision

Mivlet's supported Google model route is Google Antigravity over the Agent
Client Protocol (ACP), using Antigravity's `oauth-personal` browser sign-in.
The previous Google AI API-key route is no longer in the reachable provider
catalogue or native egress allow-list.

Mivlet downloads the official Windows x64 Antigravity ACP release into app data.
The release version, archive size, SHA-256 digest, executable names, and
uncompressed sizes are pinned. Archive contents are extracted by exact name
into a staging directory before the runtime becomes visible. Other platforms
fail closed until their official assets are independently pinned and tested.

## Credential and process boundary

Antigravity owns Google OAuth state inside a per-Mivlet-account profile. Mivlet
does not read or return those files. Each launch removes ambient Gemini and
Google credentials, forces the agent's file-backed profile, supplies the
matching local harness, and advertises an inert browser helper. Only an
explicit Mivlet sign-in action validates and opens the exact Google OAuth URL
reported by the agent.

ACP model metadata is cached without secrets. A turn uses the standard ACP
lifecycle: initialize, authenticate, create a session, select the requested
model, prompt, stream updates, and cancel or finish. Mivlet initially advertises
no client filesystem or terminal implementation.

## Approval boundary

An ACP `session/request_permission` is a request for the provider-owned agent
to perform an action; it is not a Mivlet tool call. Mivlet therefore sends it
through the same visible approval gate but does not execute the action itself.
After a one-time grant or denial, Mivlet selects the corresponding ACP option.
Missing options, missing approval wiring, stale requests, and cancellation all
fail closed. This avoids both bypassing Mivlet's approval UI and executing the
same effect twice.

## Consequences

Google sign-in is smoother and can use account-entitled models without asking
for a raw API key. The tradeoff is a large managed runtime download, a separate
local agent process, and current Windows x64-only installation. Usage and cost
remain unknown unless ACP later supplies trustworthy account-level evidence.
