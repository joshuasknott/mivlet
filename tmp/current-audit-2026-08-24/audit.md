# Fable current-state audit — 24 August 2026

## Verdict

Fable now has a credible agent-first desktop shell and is visually much closer to Grok Bot than its README suggests. The main gap is product depth and live proof, not basic layout: durable agent profiles, contextual search, a work rail, connection/knowledge surfaces, permissions, provider routing and native mission foundations exist, but Fable does not yet demonstrate Grok Bot's always-on cloud computer, teach-by-demonstration, polished routine promotion, multi-agent group chat, mature plugin catalogue, or end-to-end connector work in this browser preview.

## Current flow health

1. Provider onboarding — Mixed. Clear and skippable, but still asks for infrastructure before the user has created a teammate or received value.
2. Empty agent workspace — Visually healthy. Calm agent roster, focused conversation canvas and compact composer. The blank first state gives little guidance.
3. Agent creation — Functionally healthy, strategically mixed. Identity, instructions, model, permissions, connections, knowledge and image upload exist; the form exposes configuration that Grok Bot hides behind conversational setup.
4. Workspace search — Healthy. Searches and filters agents, work, knowledge and connections without restoring the old navigation hierarchy.
5. Connections — Mixed. The surface is clear and explicitly says `Preview data only`; browser evidence does not prove OAuth or external effects.
6. Live work and composer — Healthy shell. The work rail has ready/running/approval states and the composer switches from dictation to send when text exists. No provider was connected, so a real run was not exercised.
7. Settings — Healthy surface, incomplete account state. General, Providers, Privacy & Permissions and History are grouped in a modal; the current preview reports `Configuration required`.
8. Narrow layout — Mixed. Core controls remain usable, but the top agent strip consumes substantial height and the visible agent label truncates to `Chief of...`.

## What is implemented or strongly evidenced

- Agent profiles with create, edit, delete protection, local persistence, custom colours/images, per-agent instructions, model selection, permission preset, connection selection and knowledge selection.
- Agent-first workspace, per-agent conversation selection, workspace search and contextual work rail.
- Text composer, attachments/context menu, adaptive send control and supported-environment speech dictation.
- Multi-provider native execution boundaries, local Ollama boundary and ACP/CLI runtime support, all provider/configuration gated.
- Knowledge import/retrieval, memory controls and provenance foundations.
- Schedules, missions, approvals, artifacts, recovery and encrypted native SQLite foundations.
- Connection adapters and approval gates for Google and brokered integrations; external configuration and live-provider validation remain separate.

## What is not yet equivalent to Grok Bot

- Always-on persistent cloud computers that keep working when the user's device is away.
- Teach-by-demonstration task recording.
- Conversational agent creation and progressive tool setup.
- Multi-agent group conversation as the everyday collaboration model.
- A mature, installed plugin/connector marketplace with live account evidence.
- Routine promotion from successful work with polished trigger/run-history UX.
- Demonstrated end-to-end proactive follow-up and learned working style.
- Released, signed, updateable multi-platform product with production onboarding and shared workspaces.

## Verification

- Current desktop production build passed.
- Nineteen focused tests passed across agent surfaces, agent persistence, workspace search and composer/dictation controls.
- The broad `App.test.tsx` artifact is stale against the redesigned navigation: 24 passed and 68 failed, chiefly because it still expects Chats, Projects, Connections and model controls in their previous locations. This is a test-maintenance failure, not evidence that every corresponding runtime capability is broken.
- Browser preview was inspected at desktop and 390 x 844. No live provider, connector OAuth, consequential action, native package, microphone capture or cloud collaboration was exercised.

## Evidence files

- `01-onboarding-provider.jpg`
- `02-agent-workspace-empty.jpg`
- `03-create-agent.jpg`
- `04-workspace-search.jpg`
- `05-connections-fixture.jpg`
- `06-live-work-rail.jpg`
- `07-composer-ready-to-send.jpg`
- `08-settings-general.jpg`
- `09-mobile-agent-workspace.jpg`
