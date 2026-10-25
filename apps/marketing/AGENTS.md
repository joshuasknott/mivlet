# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Selected marketing direction

- Keep the warm background, large centred headline, lavender workspace, colourful agent characters and peach project/composer surfaces from the selected mock. Compact yellow/blue prompt-and-result cards sit beneath the hero; the main workspace and readable documents replace the repetitive full-size snippet section.
- Match the current desktop composer and sidebars; the marketing composer model label is `GPT-6.1 Sol High`.
- The workspace send action uses the app's 32px flat circle and regular 20px arrow. Reset native button appearance, border and padding so the arrow stays centred without a beveled edge.
- Use all six original app character forms as Nova, Sage, Kit, Otto, Fern and Pip. Use substantial agent-led navigation instead of tiny Research/Plan/Create pills or badges; do not repeat those controls in the orange section.
- Provider marks form a single animated line, without links or visible labels. Use ChatGPT as its accessible name and the blue/purple Gemini mark.
- No preview labels, filler eyebrows, generic decorative shield, pause controls, or reduced-motion modes. Internal offscreen/hidden playback suspension is fine.
- Change agents only on click or keyboard selection. Initially show a completed result; each selection plays that agent's scene once, then holds it. No pause/replay controls or cycling progress line. Keep the separate Projects demo showing attributed contributions to one shared outcome.
- Crossfade manual agent changes. Keep the mobile chooser in one horizontally scrollable row with all six original characters available.
- The orange composer types the selected example once and holds it. Keep user drafts separate from animated suggestions, stop animation while editing, and submit the complete example even mid-animation.
- Tie orange-section portrait emphasis and a subtle greeting motion to the composer's actual example and typing state. Keep the other portraits quiet and return all portraits to neutral when the visitor writes a custom prompt.
- Orange-card portraits are icon buttons: selecting one starts its complete example and greeting, then holds it. Preserve keyboard focus and any custom draft; returning to the composer restores the draft.
- Plugins are a separate section for work-app connections, distinct from AI providers. Follow `output/plugins-direction.png`: recognizable app-logo tiles and a mint-backed Nova prompt → Notion/Linear sources → launch-briefing example, with automatic looping and document reading. No replay controls anywhere.
- In the workspace demo, pin Plugins near the account menu with actual connected-app icons. Match the current product's full rightnav: Activity, Files, Memory, Side Chat and Schedules as direct rail items, using its icons and order. Omit the old ellipsis/Conversations menu.
- Keep the full five-item rail visible on tablet and phone layouts, collapsing only the Activity details. Preserve room for the completed result above the mobile composer and keep its model label on one line.
- Keep the browser title simply Mivlet and use the actual app favicon. Follow `output/agents-projects-direction-v2.png` for the separate six-agent and project demonstrations. Demo links go directly to the workspace; setup links go directly to the GitHub source instructions, with experimental Windows/source-release status visible before clicking. Do not add an introductory welcome dialog.
- The Projects demo now follows `output/projects-collaboration-v3.png`: six attributed conversation contributions alongside a shared launch brief, stacked on phones. Measure its natural layout so mobile text stays at native CSS size, without a fixed-canvas shrink or empty table space.
- Match the current app's icon geometry and control sizing, including its custom Plugins icon; preserve manual selection and drafts. The main agent demo opens on its completed result; the separate Projects and Plugins illustrations retain their automatic sequences.
- Remotion illustrations are silent: keep `initiallyMuted` and `numberOfSharedAudioTags={0}` so fresh visits do not wait for an audio user gesture. Loading placeholders must reserve the same desktop/tablet/mobile aspect ratios as their players.
