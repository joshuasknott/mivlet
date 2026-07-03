# Legal Implementation Checklist

```yaml
legal_status: DRAFT — LEGAL REVIEW REQUIRED
document_id: fable-legal-implementation-checklist
version: 2026-07-03-v0.1
```

---

This checklist separates **legal/owner tasks** from **engineering tasks** for publishing the Fable marketing site and waitlist. It does not assert regulatory compliance or production readiness.

## Phase 0 — Owner and legal resolution

| # | Task | Status | Placeholder / output |
| --- | --- | --- | --- |
| 0.1 | Confirm data controller legal name and postal address | ☐ | `[CONTROLLER_LEGAL_NAME]`, `[CONTROLLER_ADDRESS]` |
| 0.2 | Assign privacy and security contacts | ☐ | `[PRIVACY_CONTACT_EMAIL]`, `[SECURITY_CONTACT_EMAIL]` |
| 0.3 | Choose primary jurisdiction and governing law | ☐ | `[PRIMARY_JURISDICTION]`, `[GOVERNING_LAW]` |
| 0.4 | Confirm lawful basis for waitlist email | ☐ | `[LAWFUL_BASIS_WAITLIST]` |
| 0.5 | Set retention periods (waitlist, logs, analytics) | ☐ | `[RETENTION_*]` |
| 0.6 | Approve subprocessors and transfer mechanism | ☐ | `[SUBPROCESSOR_LIST]`, `[TRANSFER_MECHANISM]` |
| 0.7 | Set minimum age policy | ☐ | `[MINIMUM_AGE]` |
| 0.8 | Identify complaint authority references per market | ☐ | `[COMPLAINT_AUTHORITY]` |
| 0.9 | Confirm open-source license identifier | ☐ | `[OPEN_SOURCE_LICENSE]` + `LICENSE` file |
| 0.10 | Set publication effective date | ☐ | `[EFFECTIVE_DATE]` |
| 0.11 | Replace `legal_status` from draft marker to reviewed state in promoted artifacts | ☐ | Build gate config update |

## Phase 1 — Engineering (marketing site)

| # | Task | Grounding | Status |
| --- | --- | --- | --- |
| 1.1 | Create marketing site app or static export (Milestone 5) | `docs/product/roadmap.md` | ☐ |
| 1.2 | Publish legal pages from reviewed copies, not draft sources | This directory | ☐ |
| 1.3 | Implement build gate: fail if `DRAFT — LEGAL REVIEW REQUIRED` present | `README.md` marker spec | ☐ |
| 1.4 | Add footer links: Privacy, Cookies, Terms, OSS Disclaimer, Data Requests | — | ☐ |
| 1.5 | Configure `[MARKETING_DOMAIN]` and TLS | — | ☐ |
| 1.6 | Add `robots.txt` and security.txt | `website-terms.md` | ☐ |

## Phase 2 — Engineering (waitlist)

| # | Task | Spec | Status |
| --- | --- | --- | --- |
| 2.1 | Implement waitlist form with versioned notice `2026-07-03-waitlist-v0.1` | `waitlist-consent-notice.md` | ☐ |
| 2.2 | Require unchecked-by-default consent checkbox | `waitlist-consent-notice.md` | ☐ |
| 2.3 | POST consent fields to API; server-side validation | `waitlist-consent-notice.md` | ☐ |
| 2.4 | Persist `consent_text_hash` (SHA-256 of canonical notice text) | `waitlist-consent-notice.md` | ☐ |
| 2.5 | Enforce `ALLOWED_CONSENT_VERSIONS` in deployment config | `waitlist-consent-notice.md` | ☐ |
| 2.6 | Implement unsubscribe → `withdrawn_at` | `data-requests.md` | ☐ |
| 2.7 | Rate-limit signups; log abuse without storing PII in error trackers | `website-terms.md` | ☐ |
| 2.8 | Document actual vendors in published subprocessor list | `privacy-notice.md` | ☐ |

## Phase 3 — Engineering (cookies and analytics)

| # | Task | Spec | Status |
| --- | --- | --- | --- |
| 3.1 | Consent banner blocks non-essential scripts until choice | `cookie-analytics-notice.md` | ☐ |
| 3.2 | Store `fable_cookie_consent` with notice version | `cookie-analytics-notice.md` | ☐ |
| 3.3 | Provide cookie preferences page at `[COOKIE_SETTINGS_PATH]` | `cookie-analytics-notice.md` | ☐ |
| 3.4 | Confirm analytics only loads if `analytics: true` | `cookie-analytics-notice.md` | ☐ |

## Phase 4 — Engineering (downloads and product boundary)

| # | Task | Grounding | Status |
| --- | --- | --- | --- |
| 4.1 | Download page shows preview / unsigned notices | `open-source-disclaimer.md`, `release.md` | ☐ |
| 4.2 | Clarify desktop app privacy is separate from marketing site | `privacy-notice.md` | ☐ |
| 4.3 | Do not bundle waitlist tracking into desktop app | `README.md` | ☐ |
| 4.4 | Keep auth broker (`auth.fable.app`) separate from waitlist API | `docs/connectors/auth-broker.md` | ☐ |

## Phase 5 — Operational readiness

| # | Task | Status |
| --- | --- | --- |
| 5.1 | Privacy request runbook and ticket queue | ☐ |
| 5.2 | Test access/deletion/withdrawal end-to-end | ☐ |
| 5.3 | Verify email templates include unsubscribe and controller identity | ☐ |
| 5.4 | Archive superseded notice versions with hashes | ☐ |
| 5.5 | Legal sign-off recorded before removing draft build gate | ☐ |

---

## Build gate pseudocode

```text
for each legal_source in docs/marketing/legal/*.md:
  if publishing_from(legal_source):
    if legal_source.legal_status == "DRAFT — LEGAL REVIEW REQUIRED":
      FAIL "Legal source still in draft"
    if legal_source.version not in ALLOWED_PUBLISHED_VERSIONS:
      FAIL "Version not approved for publish"

for waitlist_deploy:
  if "2026-07-03-waitlist-v0.1" not in ALLOWED_CONSENT_VERSIONS:
    FAIL "Waitlist consent version not approved"
```

## Explicit non-goals for this checklist

- Does **not** claim GDPR, UK GDPR, CCPA, or other regulatory compliance.
- Does **not** claim security certification or attorney review.
- Does **not** mark the product or site as production-ready.
- Does **not** modify Fable desktop runtime behavior.