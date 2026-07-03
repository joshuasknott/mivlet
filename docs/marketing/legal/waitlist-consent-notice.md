# Waitlist Consent Notice — Source Text

```yaml
legal_status: DRAFT — LEGAL REVIEW REQUIRED
document_id: fable-waitlist-consent-notice
version: 2026-07-03-waitlist-v0.1
effective_date: "[EFFECTIVE_DATE]"
consent_text_hash_algorithm: sha256
```

---

## Legal text (shown at signup)

### Waitlist signup notice

**Version:** `2026-07-03-waitlist-v0.1`

By joining the Fable waitlist, you agree that:

1. **We will collect your email address** (and any optional information you choose to provide on the form) to manage your place on the waitlist and send you product-related updates about Fable.
2. **Fable is in preview.** The open-source desktop app (currently version 0.1.0) is an early preview. Features, timelines, and availability may change. Waitlist signup does not guarantee access, priority, pricing, or a delivery date.
3. **This is a marketing waitlist, not a Fable account.** Joining the waitlist does not create a hosted Fable workspace account and does not give us access to your local desktop data, files, API keys, or connector credentials.
4. **Email from us.** We may email you about waitlist status, early access opportunities, and major product announcements. You can withdraw consent and unsubscribe using the link in our emails or by contacting `[PRIVACY_CONTACT_EMAIL]`.
5. **How we handle your data** is described in our [Privacy Notice](./privacy-notice.md). Our [Cookie Notice](./cookie-analytics-notice.md) applies if analytics or preference cookies are enabled on the page.

**Data controller:** `[CONTROLLER_LEGAL_NAME]`  
**Contact:** `[PRIVACY_CONTACT_EMAIL]`

**Checkbox label (required, unchecked by default):**

> I agree to the Waitlist Signup Notice (version `2026-07-03-waitlist-v0.1`) and want to receive waitlist and product update emails from Fable.

---

## Versioning policy

| Version ID | Date | Summary |
| --- | --- | --- |
| `2026-07-03-waitlist-v0.1` | 2026-07-03 | Initial draft aligned to proposed waitlist flow |

When notice text changes in a material way:

1. Increment the version ID (for example `2026-07-15-waitlist-v0.2`).
2. Update `effective_date` after legal review.
3. Recompute `consent_text_hash` for the exact rendered text shown to users.
4. Keep prior versions in this directory for audit reference.
5. Do **not** retroactively change stored consent records.

---

## Engineering requirements (form and API)

These requirements are factual implementation specs. They are **not** legal assurances.

### UI requirements

- Show the full notice text (or a conspicuous link that opens the full text without leaving the signup flow).
- Display the version ID `2026-07-03-waitlist-v0.1` adjacent to the checkbox.
- Require an explicit, unchecked-by-default checkbox; disable submit until checked.
- Link to Privacy Notice and Cookie Notice.
- On submit failure, do not clear the checkbox state.

### API request body (proposed)

```json
{
  "email": "user@example.com",
  "consent_notice_version": "2026-07-03-waitlist-v0.1",
  "consent_notice_accepted_at": "2026-07-03T12:34:56.789Z",
  "consent_method": "explicit_checkbox",
  "consent_text_hash": "sha256:…",
  "source_url": "https://[MARKETING_DOMAIN]/waitlist",
  "locale": "en-GB",
  "utm": {
    "source": "github",
    "medium": "readme",
    "campaign": "preview"
  }
}
```

### Server-side validation

| Rule | Behavior |
| --- | --- |
| `consent_notice_version` | Must match a published, non-draft version allowed by the deployment config |
| `consent_method` | Must be `explicit_checkbox` for this notice version |
| `consent_text_hash` | Must match the SHA-256 of the canonical notice text for that version |
| `consent_notice_accepted_at` | Must be ISO 8601 UTC; reject if more than 10 minutes skew from server time |
| `email` | Normalize (lowercase, trim); reject invalid format |
| Missing consent fields | Reject with 400; do not create a waitlist record |

### Storage record (proposed)

Persist immutable consent evidence with the waitlist row:

```
waitlist_entry {
  id: uuid
  email: string (indexed, unique)
  created_at: timestamp
  consent_notice_version: string
  consent_notice_accepted_at: timestamp
  consent_method: string
  consent_text_hash: string
  source_url: string
  locale: string | null
  utm_json: json | null
  withdrawn_at: timestamp | null
  withdrawal_method: string | null
}
```

### Withdrawal

- Set `withdrawn_at` when the user unsubscribes or submits a deletion request.
- Stop marketing email promptly; retention of minimal unsubscribe evidence follows `[RETENTION_WAITLIST]`.
- Do not delete consent evidence solely because marketing stopped; legal may require proof of consent.

### Build gate integration

Deployment config should define `ALLOWED_CONSENT_VERSIONS`. The marketing build must fail if:

- `legal_status` in the source notice file is still `DRAFT — LEGAL REVIEW REQUIRED`, or
- the configured allowed version does not match a reviewed notice artifact.

---

## Unresolved inputs

- `[CONTROLLER_LEGAL_NAME]`, `[CONTROLLER_ADDRESS]`, `[PRIVACY_CONTACT_EMAIL]`
- `[LAWFUL_BASIS_WAITLIST]` — consent vs. legitimate interest for follow-up email
- `[RETENTION_WAITLIST]`
- `[MARKETING_DOMAIN]`
- Email provider and double opt-in policy (owner decision)