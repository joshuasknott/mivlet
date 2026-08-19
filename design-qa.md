# Fable agent workspace design QA

## Comparison target

- Source visual truth: `C:\Users\Josh\.codex\attachments\c307d40a-4c78-420c-8690-6c4121e53271\image-1.png`
- Final implementation capture: `C:\Users\Josh\Projects\fable\docs\design\qa\agent-workspace-final.png`
- Combined comparison input: `C:\Users\Josh\Projects\fable\docs\design\qa\agent-workspace-comparison-final.png`
- Search capture: `C:\Users\Josh\Projects\fable\docs\design\qa\workspace-search-final.png`
- Connections capture: `C:\Users\Josh\Projects\fable\docs\design\qa\connections.png`
- Viewport: 1486 x 1058 CSS pixels, light theme, desktop agent workspace
- Source pixels: 1486 x 1058
- Implementation pixels: 1486 x 1058
- Density normalization: equal source and implementation pixel dimensions; no resampling was needed for the final comparison.
- State: Chief of Staff selected with one user message and no active run. The source contains a longer completed example run; the implementation deliberately renders real runtime state instead of inventing completed work or approvals.

## Findings

No actionable P0, P1, or P2 design differences remain.

- Typography: Inter remains the product typeface. Workspace, agent, message, and work-rail hierarchy now follow the source's optical scale without introducing a separate display face.
- Spacing and layout: the desktop tracks are 308 px / fluid 764 px / 414 px at the source viewport. The 108 px agent header, 700 px composer, bottom dock, left navigation rhythm, and work-rail section start align with the source composition.
- Colors and tokens: the implementation uses Fable's existing neutral surfaces, violet agent accent, semantic green/caution states, and tokenized borders/shadows. Contrast remains valid in both light and dark themes.
- Image and icon fidelity: the implementation uses the shared Fold mascot selected by the user, real connector brand assets, and Phosphor controls. The mascot is a single colour-parameterized vector component because the user explicitly requested an exact code implementation rather than a raster asset.
- Copy and content: visible teammate language is removed. The product now says Agents and Connections. Search copy is plain-language and connector setup internals are not exposed in workspace search results.
- Interaction and accessibility: Search opens from the button and Ctrl+K, traps focus, filters by All / Agents / Work / Knowledge / Connections, closes on Escape, and returns focus. Connection cards, catalogue search, modal details, the composer, agent selection, theme selection, and work-rail close/reopen were exercised in the browser.
- Responsiveness: 1024 x 768 and 640 x 900 captures show no persistent overlap or clipped controls. At compact widths the work rail is a dismissible overlay; with it closed, Search, Agents, the conversation, and the composer remain usable.
- Browser console: no errors were recorded during the final interaction pass.

## Focused evidence

The final combined input preserves both full 1486 x 1058 frames at native width, so the header, sidebar, message typography, composer, work rail, icons, borders, and spacing remain directly readable without a downsampled crop. Separate full-resolution Search and Connections captures cover the two new interaction-heavy regions; no additional focused crop was necessary.

## Comparison history

1. Initial capture: `agent-workspace-implemented-1486x1058.png`
   - [P1] The empty composer floated in the center instead of belonging to the conversation.
   - [P2] The work rail and center track did not match the source proportions, and the agent header was too shallow.
   - [P2] User messages rendered as right-aligned chat bubbles rather than an authored human-agent stream.
   - Fixes: anchored the composer at the bottom; set source-matched column and header dimensions; added message authors and left-aligned plain message content.
2. Structural correction: `agent-workspace-pass-2.png`
   - The composer, columns, and header aligned. The message hierarchy and work-rail vertical rhythm still differed.
   - Fixes: introduced human/agent author rows, removed the user bubble treatment, aligned the Work title/sections, and preserved real runtime state.
3. Content correction: `agent-workspace-pass-3.png`
   - Core fidelity passed. Remaining refinements were the heavy primary sidebar button, small navigation type, and conversation previews in the agent list.
   - Fixes: matched the quiet outlined New agent control, increased navigation type, and reduced each agent row to identity only. Conversation text remains discoverable through the agent and workspace Search, not as a separate product section.
4. Final evidence: `agent-workspace-final.png` and `agent-workspace-comparison-final.png`
   - Earlier P1/P2 findings are resolved. No new P0/P1/P2 findings were found.

## Follow-up polish

- [P3] Populated work-rail captures should be added once a live or deterministic preview run exposes real progress, completion, and approval states without fabricated data.

## Fold mascot implementation QA — 2026-08-18

### Comparison target

- Source visual truth: `C:\Users\Josh\AppData\Local\Temp\codex-clipboard-fe122c8c-5012-42e8-b0bf-cab3abcc4292.png`
- Browser-rendered workspace: `C:\Users\Josh\Projects\fable\docs\design\qa\fold-agent-workspace.png`
- Browser-rendered editor: `C:\Users\Josh\Projects\fable\docs\design\qa\fold-agent-editor.png`
- Focused source/implementation comparison: `C:\Users\Josh\Projects\fable\docs\design\qa\fold-agent-comparison.png`
- Viewport: 1486 x 1058 CSS pixels, device scale factor 1, light theme.
- Source pixels: 1254 x 1254. Focused purple mascot cutout: 274 x 295.
- Implementation pixels: 1486 x 1058 full capture. Production avatar boxes: 34 x 34 in the sidebar and 48 x 48 in the editor; focused rendered cutout: 40 x 41.
- Density normalization: the focused cutouts are fitted into equal 300 x 300 comparison regions to judge silhouette, fold, eye position, and proportions. The full browser captures remain the authority for production size and antialiasing.
- State: Chief of Staff selected; violet Fold visible in the sidebar/header; editor colour interaction separately exercised with blue and violet.

### Findings

No actionable P0, P1, or P2 mascot differences remain at the production avatar sizes.

- Fonts and typography: no type surfaces changed.
- Spacing and layout rhythm: the background-free mascot occupies a 32 x 32 SVG inside the 34 x 34 sidebar avatar and a 34 x 34 SVG in the 36 x 36 header avatar, increasing presence without changing row or header geometry.
- Colors and visual tokens: the six source colours are implemented as Violet `#865DFA`, Blue `#3581FB`, Green `#2CC663`, Amber `#FCBD22`, Coral `#FC6D69`, and Slate `#555B63`. The fold highlight and shadow are derived from the selected colour so every agent retains the same identity.
- Image quality and asset fidelity: the shared Fold silhouette, separate darker page fold, and two charcoal oval eyes match the supplied source. The vector stays sharp across the sidebar, header, message author, Search, and editor sizes. No circle, card surface, border, or shadow remains around the mascot.
- Copy and content: no new mascot label or separate icon ontology was introduced; every profile remains an Agent distinguished by colour.
- Interaction and accessibility: all six colour controls remain named and keyboard-addressable. Blue selection updated the preview to `#3581FB`; saving Violet persisted `#865DFA`. Browser console warnings/errors: none.

### Comparison history

1. Initial implementation:
   - [P2] The mascot was placed inside an off-white circular card with a border and shadow, contrary to the requested standalone icon.
   - [P2] The visible mascot was too small beside Grok Bot's agent-icon scale.
   - Fix: removed background, border, radius, and shadow; increased rendered sizes across every agent surface and tightened the SVG view box.
2. First focused source/implementation comparison:
   - [P2] The folded tuft had insufficient contrast and the eyes read wider than the source when normalized.
   - Fix: enlarged and darkened the folded tuft, reduced eye width/height, and recaptured the actual editor and workspace states.
3. Final focused and full-view evidence:
   - Earlier P2 findings are resolved. Computed browser styles confirm transparent background, zero border, no shadow, 32 x 32 sidebar SVG, and the exact Violet token. No new P0/P1/P2 findings were found.

### Fold implementation checklist

- [x] One shared mascot for every agent
- [x] Colour is the only built-in agent-specific visual variable
- [x] Exact six-colour source palette
- [x] No card background, border, radius, or shadow
- [x] Larger Grok-like avatar presence
- [x] Sidebar, header, Search, message, and editor coverage
- [x] Colour selection and persistence exercised
- [x] Browser console checked

## Implementation checklist

- [x] Agents-first conversational shell
- [x] No top-level Conversations section
- [x] Workspace-wide Search with scoped filters
- [x] Projects and routines represented as Work, not as conversations
- [x] Minimal Connections catalogue with Installed section
- [x] Desktop, tablet, and compact-width browser checks
- [x] Keyboard and focus behavior
- [x] Browser console check
- [x] Production build

final result: passed
