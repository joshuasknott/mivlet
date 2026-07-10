# Open-Source & Preview Product Disclaimer — Source Text

> **Not for publication.** Fable's open-source decision is deferred and there is no committed license in this repository. This historical draft must not be used in product, marketing, legal, or release copy until a future explicit licensing decision replaces it.

```yaml
legal_status: DRAFT — LEGAL REVIEW REQUIRED
document_id: fable-open-source-disclaimer
version: 2026-07-03-v0.1
effective_date: "[EFFECTIVE_DATE]"
```

---

## Legal text (for publication)

### Open-source software

Fable is an open-source AI workspace for real work. Source code, protocol types, and technical documentation are published in the project repository for inspection and community contribution.

**License:** `[OPEN_SOURCE_LICENSE]` — *Owner to confirm the SPDX license identifier applied at release (not declared in this repository snapshot).*

Unless a file header states otherwise, use of the source code is governed by that license, not by marketing-site copy.

### Preview product status

The Fable desktop application is an **early preview** (currently version **0.1.0** in the repository). You should expect:

- **Incomplete or gated features.** Voice input, local model execution through user-installed Ollama, GitHub Copilot execution, multi-OS packaging, and other items are planned, gated, preview-only, or not yet implemented (see `README.md` feature matrix).
- **Unsigned builds.** Windows preview builds are unsigned (`docs/product/release.md`).
- **Configuration required.** Many connectors need provider setup, OAuth registration, or a deployed auth broker before they work outside fixtures.
- **Data on your device.** The desktop app is designed to be local-first. You are responsible for backups, workspace security, and how you configure API keys and connectors.
- **No uptime or support SLA.** Preview software may crash, lose unsaved state, or change behavior between releases.

### No warranty

Open-source and preview software is provided **without warranty of any kind**, to the extent permitted by applicable law and the open-source license. We do not guarantee fitness for a particular purpose, non-infringement, or error-free operation.

### Limitation of liability

To the extent permitted by law, contributors and `[CONTROLLER_LEGAL_NAME]` are not liable for damages arising from use of preview builds. Some jurisdictions do not allow certain exclusions; in those cases, liability is limited to the maximum extent permitted.

*Legal to align with license warranty disclaimers and corporate policy.*

### Third-party services

Fable can connect to third-party providers (for example OpenAI, Anthropic, Google, GitHub, Notion, Slack). Your use of those services is subject to their terms and billing. Fable does not control provider availability, pricing, or data handling.

The optional auth broker and optional Convex deployment are separate hosted components with their own configuration and risk profile (`docs/product/release.md`).

### Security

Fable publishes a threat model (`docs/security/threat-model.md`) describing engineering controls and remaining work. That document is a technical aid, **not** a certification or guarantee of security.

Report suspected vulnerabilities to `[SECURITY_CONTACT_EMAIL]` — *owner to assign*.

### Contributions

If you contribute to the repository, you agree to follow the project's contribution terms once published (`[CONTRIBUTION_AGREEMENT]`). Until then, do not rely on unstated CLA/DCO requirements.

### Relationship to website terms

Use of the marketing website is governed by [Website Terms](./website-terms.md). Use of downloaded software is governed by the open-source license and this disclaimer.

---

## Engineering facts (repository-grounded)

| Topic | Current repository state |
| --- | --- |
| Version | `0.1.0` (`package.json`) |
| Desktop shell | Tauri 2 with local SQLite vault (`README.md`) |
| Hosted account | Not required for core desktop workspace |
| Connectors | Mix of live-gated and fixture-preview states |
| Broker | In-memory handoff not production-ready (`docs/product/release.md`) |
| Brand legacy ID | `com.arden.workspace` retained (`docs/brand.md`) |

## Unresolved inputs

- `[OPEN_SOURCE_LICENSE]` — no `LICENSE` file in repository at draft time
- `[CONTROLLER_LEGAL_NAME]`
- `[SECURITY_CONTACT_EMAIL]`
- `[CONTRIBUTION_AGREEMENT]` — CLA, DCO, or inbound=outbound policy
