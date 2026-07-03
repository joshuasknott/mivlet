# Marketing Site Privacy Notice — Source Text

```yaml
legal_status: DRAFT — LEGAL REVIEW REQUIRED
document_id: fable-marketing-privacy-notice
version: 2026-07-03-v0.1
effective_date: "[EFFECTIVE_DATE]"
```

---

## Legal text (for publication)

### Who we are

Fable is an open-source, local-first AI workspace for real work. This notice describes how we handle personal information when you visit the Fable marketing website or join the product waitlist.

**Data controller:** `[CONTROLLER_LEGAL_NAME]`  
**Address:** `[CONTROLLER_ADDRESS]`  
**Privacy contact:** `[PRIVACY_CONTACT_EMAIL]`

### What this notice covers

This notice applies to the public marketing website and waitlist signup flow. It does **not** describe how the Fable desktop application handles your local workspace, files, API keys, connectors, or on-device data. The desktop app is designed to keep most work on your device; see the product documentation and open-source repository for technical details.

### Information we collect

**Information you provide**

- **Waitlist signup:** email address and any optional fields shown on the form (for example, name or role), plus your explicit consent to the waitlist notice.
- **Contact requests:** information you send when you email us or use a contact form.

**Information collected automatically**

- **Server and security logs:** IP address, user agent, request timestamps, and error diagnostics needed to operate and protect the site.
- **Cookies and similar technologies:** as described in our cookie and analytics notice.

We do not ask waitlist visitors for passwords, payment card numbers, government identification, or access to your Fable desktop workspace.

### How we use information

We use personal information to:

- operate and secure the marketing site;
- record and manage waitlist signups;
- send waitlist-related messages you have agreed to receive;
- measure basic site performance and fix errors;
- respond to privacy and support requests.

We do **not** use waitlist data to access your local Fable desktop workspace.

### Legal basis

`[LAWFUL_BASIS_WAITLIST]` — *Owner/legal to confirm lawful basis for waitlist processing and optional marketing email.*

### How long we keep information

| Data | Retention |
| --- | --- |
| Waitlist records | `[RETENTION_WAITLIST]` |
| Server and security logs | `[RETENTION_LOGS]` |
| Cookie/analytics data | As stated in the cookie notice |

### Who we share information with

We use service providers to host the site, operate the waitlist API, send email, and (if enabled) run analytics. A current list will be published at `[SUBPROCESSOR_LIST]`.

We may disclose information if required by law or to protect the rights, safety, and security of Fable, our users, or the public.

We do **not** sell personal information as part of this waitlist flow.

### International transfers

If personal information is processed outside your country, we rely on: `[TRANSFER_MECHANISM]`. *Owner/legal to confirm.*

### Your choices and rights

Depending on where you live, you may have rights to access, correct, delete, or restrict use of your personal information, and to withdraw consent where processing is consent-based.

To exercise these rights, follow the procedure in our [data requests document](./data-requests.md) or email `[PRIVACY_CONTACT_EMAIL]`.

If you are not satisfied with our response, you may contact: `[COMPLAINT_AUTHORITY]`.

### Children

The marketing site and waitlist are intended for people aged `[MINIMUM_AGE]` and older. We do not knowingly collect information from children below that age.

### Changes

We will update this notice when our practices change. The effective date at the top will change when a new version is published.

### Open-source transparency

Fable's product source code is open. Marketing-site infrastructure code may be published separately. Technical documentation in the repository describes local-first storage, credential boundaries, and connector behavior for the desktop app; those details are engineering facts, not a promise that the marketing site processes data the same way.

---

## Engineering facts (not legal promises)

Grounded in the current repository:

- The desktop workspace does not require a hosted Fable account (`docs/product/release.md`).
- API keys and connector tokens are handled by local runtime boundaries, not the marketing site (`docs/security/threat-model.md`).
- Milestone 5 plans a brand/marketing site with legal pages and Vercel preview (`docs/product/roadmap.md`).
- Release readiness notes that download/legal pages are still outstanding (`docs/product/release.md`).

The waitlist store, email provider, and analytics tooling are **not implemented** in this repository snapshot. Engineering must map actual vendors to `[SUBPROCESSOR_LIST]` before publication.