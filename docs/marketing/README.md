# Fable marketing site and waitlist — documentation index

**Status:** Implementation-grade specification (documentation only; no site, worker, or deployment in this commit).

**Branch:** `grok/overnight-waitlist-spec`

**Evidence audited:** 2026-07-03 against repository sources listed below. Product claims trace to those files; absent evidence is called out explicitly and must not be fabricated in public copy.

## Documents

| Document | Purpose |
| --- | --- |
| [marketing-site-and-waitlist-spec.md](./marketing-site-and-waitlist-spec.md) | Authoritative implementation spec: audience, IA, messaging, visuals, waitlist contract, stack, diagrams, tests, environments, launch checklist, forbidden claims |
| [waitlist-api.schema.json](./waitlist-api.schema.json) | Normative JSON Schema for `apps/waitlist` Worker API (not `apps/broker`) |
| [legal/](./legal/) | Draft legal source material — **DRAFT — LEGAL REVIEW REQUIRED** before publication |

## Product evidence sources (read before changing copy)

| Topic | Source |
| --- | --- |
| Feature truth matrix | `README.md` (Feature Status Matrix), `docs/product/status.md` |
| Local-first / no Fable account | `docs/product/release.md`, `docs/product/status.md` |
| Connectors and gating | `docs/product/connectors.md`, `docs/connectors/auth-broker.md` |
| Windows preview only | `README.md`, `docs/product/release.md` |
| Brand and voice | `docs/brand.md`, `apps/desktop/public/brand/` |
| Vision and non-goals | `docs/product/vision.md`, `docs/product/thesis.md` |
| Threat model | `docs/security/threat-model.md` |
| Broker scope (OAuth only) | `docs/connectors/auth-broker.md`, `apps/broker/` |
| Monorepo layout | `pnpm-workspace.yaml`, root `package.json` |

## Connector label vocabulary (public)

Marketing may use only these four labels (see spec §5):

| Label | Meaning |
| --- | --- |
| **Implemented** | Live in local desktop runtime; no hosted Fable account required |
| **Gated** | Code exists; needs user or operator setup (keys, Google Cloud, CLI, broker deploy) |
| **Preview-only** | UI or policy architecture present; live transport or execution deferred |
| **Missing** | Cataloged or planned; not runnable |

## Operational ownership (proposed)

| Area | Primary owner | Backup |
| --- | --- | --- |
| Marketing copy accuracy vs product matrix | Product / engineering | — |
| Waitlist Worker and D1 schema | Platform / infra | Security review before prod |
| Legal pages and consent text | **Owner / legal decision** | External counsel |
| Analytics and Turnstile configuration | Growth / marketing ops | Security |
| Incident response (waitlist breach, spam) | On-call platform | Legal if PII involved |
| OAuth broker (`apps/broker`) | Platform eng | Security — **must not store marketing data** |

## Out of scope for this documentation commit

- Implementing `apps/marketing` or `apps/waitlist`
- Push, merge, deploy, domain registration, or external resource creation
- Extending the OAuth broker with waitlist or analytics routes