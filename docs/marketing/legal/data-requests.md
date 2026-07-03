# Access, Deletion & Consent Withdrawal Procedure — Source Text

```yaml
legal_status: DRAFT — LEGAL REVIEW REQUIRED
document_id: fable-data-requests-procedure
version: 2026-07-03-v0.1
effective_date: "[EFFECTIVE_DATE]"
```

---

## Legal text (for publication)

### Your privacy choices

You can ask us about personal information we handle through the **marketing website and waitlist**. This procedure does **not** cover data stored locally in your Fable desktop application on your device.

**Contact:** `[PRIVACY_CONTACT_EMAIL]`  
**Controller:** `[CONTROLLER_LEGAL_NAME]`

### What you can request

Depending on applicable law and our records, you may request:

| Request type | What we will try to do |
| --- | --- |
| **Access** | Confirm whether we hold your information and provide a copy of waitlist/contact data we control |
| **Correction** | Fix inaccurate email or contact details |
| **Deletion** | Remove waitlist or contact records we no longer need to retain |
| **Withdraw consent** | Stop waitlist/marketing email and record your withdrawal |
| **Restrict processing** | Limit certain uses while a request is reviewed |

We may need to keep minimal records to prove consent, honor unsubscribe status, or meet legal obligations (`[RETENTION_WAITLIST]`).

### How to submit a request

1. Email `[PRIVACY_CONTACT_EMAIL]` from the address you used to sign up (or explain if you no longer have access).
2. Use the subject line: **Fable Privacy Request — [Access / Deletion / Withdrawal / Other]**
3. Include:
   - your email address;
   - the request type;
   - the page or product area (for example, "waitlist on `[MARKETING_DOMAIN]`");
   - any reference date of signup if known.
4. We may ask reasonable questions to confirm your identity before disclosing or deleting data.

### Timelines

We aim to respond within `[RESPONSE_TIMEFRAME]` calendar days. Complex requests may take longer; we will explain if so.

*Legal to set formal statutory deadlines per jurisdiction.*

### Waitlist withdrawal (self-service)

If you receive waitlist email, use the **unsubscribe** link in that message. This should trigger withdrawal processing without a separate email.

Engineering must ensure unsubscribe updates `withdrawn_at` on the waitlist record (see [`waitlist-consent-notice.md`](./waitlist-consent-notice.md)).

### Local desktop data

Fable's desktop workspace stores files, memory, approvals, and credentials on your device. We cannot delete local data you never sent to us. To remove local data:

- uninstall the application if desired;
- delete the app data directory for your platform;
- revoke connector tokens in provider consoles.

Technical paths are documented in product docs; they are engineering instructions, not legal advice.

### Complaints

If you believe we handled your information improperly, contact us first at `[PRIVACY_CONTACT_EMAIL]`. You may also lodge a complaint with `[COMPLAINT_AUTHORITY]` where applicable.

---

## Engineering requirements (operational runbook)

### Intake tracking (proposed)

```
privacy_request {
  id: uuid
  received_at: timestamp
  request_type: enum(access, correction, deletion, withdrawal, restrict, other)
  requester_email: string
  verified_at: timestamp | null
  status: enum(open, verifying, in_progress, completed, rejected)
  completed_at: timestamp | null
  handler: string | null
  notes: text (no secrets)
}
```

### Verification

- Prefer verification from the same email address on the waitlist row.
- If the requester uses a different email, require additional evidence (owner/legal to define).
- Do not disclose whether an email exists until identity is verified.

### Deletion scope for waitlist

When honoring deletion:

1. Remove or anonymize `email` and optional profile fields.
2. Retain `consent_notice_version`, `consent_notice_accepted_at`, `consent_text_hash`, and `withdrawn_at` only if legal approves minimal proof retention.
3. Propagate unsubscribe to email provider suppression list.

### Logging

- Do not log full request email bodies in application error trackers.
- Redact tokens and unrelated third-party data from support tickets.

### Unresolved inputs

- `[RESPONSE_TIMEFRAME]`
- `[COMPLAINT_AUTHORITY]`
- Identity verification policy for non-email channels
- Whether a web form is required in addition to email