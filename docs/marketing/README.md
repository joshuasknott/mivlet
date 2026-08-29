# Marketing and waitlist notes

`apps/marketing` is the Astro public site and `apps/waitlist` is its isolated
Cloudflare signup Worker. Neither is deployed by repository tests or builds.

## Sources of truth

- Root `README.md`: current product maturity and verified capability categories.
- `docs/product/vision.md`: product direction and non-goals.
- `docs/product/connectors.md`: connector boundaries.
- `docs/security/threat-model.md`: security assumptions.
- `waitlist-api.schema.json`: waitlist request/response contract.

Public copy must distinguish:

- **Implemented**: present and exercised in the repository-local runtime.
- **Configuration-gated**: code exists but needs user or operator setup.
- **Deployment-gated**: infrastructure exists in source but is not proven live.
- **Missing**: not implemented.

Do not infer live providers, hosted agents, revenue, public availability, privacy
compliance, or competitor parity from fixtures, tests, screenshots, builds, or
Wrangler dry-runs. Legal and consent copy requires a fresh product/legal review
before publication; the former historical draft set was intentionally removed.
