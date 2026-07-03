# Cookie & Analytics Notice — Source Text

```yaml
legal_status: DRAFT — LEGAL REVIEW REQUIRED
document_id: fable-cookie-analytics-notice
version: 2026-07-03-v0.1
effective_date: "[EFFECTIVE_DATE]"
```

---

## Legal text (for publication)

### Cookies and similar technologies

This notice explains how the Fable marketing website uses cookies, local storage, and similar technologies.

**Controller:** `[CONTROLLER_LEGAL_NAME]`  
**Contact:** `[PRIVACY_CONTACT_EMAIL]`

### What are cookies?

Cookies are small text files stored on your device. We also use similar technologies such as local storage and session storage where needed for site operation.

### Categories we use (or may use)

| Category | Purpose | Typical duration | Consent needed? |
| --- | --- | --- | --- |
| **Strictly necessary** | Security, load balancing, form submission integrity, consent record | Session to 12 months | No — required for site function |
| **Preference** | Remember language or cookie choices | Up to 12 months | Yes — if not strictly necessary |
| **Analytics** | Understand page views, referrers, and funnels for the marketing site | `[RETENTION_ANALYTICS]` | Yes — before non-essential analytics load |
| **Marketing** | Measure ad campaigns if paid promotion is used | `[RETENTION_MARKETING_COOKIES]` | Yes — if used |

*Owner/engineering to confirm which categories are enabled at launch. Do not load non-essential analytics before consent.*

### What we do not do on the marketing site

- We do not use waitlist cookies to read your Fable desktop workspace.
- We do not place connector, API-key, or chat-session tokens from the desktop app onto the marketing site.

### Third-party tools

If analytics or hosting providers set their own cookies, they act as processors under our instructions. A list will be published at `[SUBPROCESSOR_LIST]`.

### Your choices

On first visit, non-essential cookies should remain off until you choose:

- **Accept all** — enable preference and analytics cookies per configuration.
- **Reject non-essential** — only strictly necessary cookies run.
- **Manage preferences** — choose categories individually.

You can change your choice later via `[COOKIE_SETTINGS_PATH]` or your browser settings. Browser controls may affect site functionality.

### Updates

We will update this notice when tools or categories change. Check the effective date above.

---

## Engineering requirements (not legal promises)

### Consent banner behavior (proposed)

1. Block non-essential scripts until consent is stored.
2. Persist consent as:

```json
{
  "notice_version": "2026-07-03-v0.1",
  "choices": {
    "necessary": true,
    "preferences": false,
    "analytics": false,
    "marketing": false
  },
  "recorded_at": "2026-07-03T12:00:00.000Z"
}
```

3. Store in a first-party cookie `fable_cookie_consent` (Strictly Necessary) or local storage with the same fields.
4. Expose `window.fableConsent` (or equivalent) so analytics loaders can read choices without re-parsing cookies.

### Repository grounding

- Roadmap Milestone 5 targets a Vercel-hosted marketing preview (`docs/product/roadmap.md`).
- No analytics implementation exists in the repository today; vendor selection is `[SUBPROCESSOR_LIST]`.

### Unresolved inputs

- `[RETENTION_ANALYTICS]`, `[RETENTION_MARKETING_COOKIES]`
- `[COOKIE_SETTINGS_PATH]` (for example `/cookie-preferences`)
- Exact analytics vendor and whether IP addresses are truncated
- Whether a Consent Management Platform is required for EU/UK visitors — **legal to decide**; do not claim compliance in copy