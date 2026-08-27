# Fable reference-shell design QA

## Evidence

- Source visual truth: `C:\Users\Joshua Knott\Projects\fable\tmp\design-qa\fable-reference-source.png`
- Desktop implementation: `C:\Users\Joshua Knott\Projects\fable\tmp\design-qa\fable-reference-shell-desktop.png`
- Mobile implementation: `C:\Users\Joshua Knott\Projects\fable\tmp\design-qa\fable-reference-shell-mobile.png`
- Side-by-side comparison: `C:\Users\Joshua Knott\Projects\fable\tmp\design-qa\fable-reference-comparison.png`
- Empty adaptive action: `C:\Users\Joshua Knott\Projects\fable\tmp\design-qa\fable-adaptive-action-empty.png`
- Typed adaptive action: `C:\Users\Joshua Knott\Projects\fable\tmp\design-qa\fable-adaptive-action-typed.png`
- Mobile adaptive action: `C:\Users\Joshua Knott\Projects\fable\tmp\design-qa\fable-adaptive-action-mobile.png`
- Desktop viewport: 900 x 679 CSS px
- Mobile viewport: 390 x 844 CSS px
- Source pixels: 900 x 679
- Desktop implementation pixels: 900 x 679
- Mobile implementation pixels: 390 x 844
- Device scale factor: 1
- Density normalization: none required; source and desktop implementation were compared at identical pixel and CSS dimensions.
- State: light theme, one selected agent, live-work rail closed. The reference contains populated conversation content while the local Fable preview has no saved conversation; chrome, hierarchy, spacing, and controls were compared as the requested surfaces.

## Full-view comparison

The final side-by-side comparison confirms the reference hierarchy: a fixed 280 px agent sidebar, a quiet top-right plus control, a compact search field without a shortcut badge, one selected agent row, a 48 px conversation header, and a single-line composer docked near the bottom. The workspace label, `Preview workspace`, `Agents` section label, and always-visible utility links are absent. The live-work rail is closed by default and remains available from the header.

## Focused comparison

Focused measurement was required because the requested differences are small controls and spacing details:

- New-agent control: 30 x 30 px on desktop; 40 x 40 px touch target on mobile.
- Search field: 34 px high on desktop; no `Ctrl K` text in the rendered document.
- Sidebar: 280 px wide at the 900 px reference viewport.
- Conversation header: 48 px high; agent mark is 22 x 22 px.
- Composer: 581 x 52 px at the desktop reference viewport, with the add control on the left and voice/send controls on the right.
- Overflow: document width equals viewport width at both 900 px and 390 px.

## Required fidelity surfaces

- Fonts and typography: Fable retains its bundled Inter family. Sizes and weights now match the compact reference hierarchy; agent names truncate without wrapping in the desktop list.
- Spacing and layout rhythm: sidebar, header, search, selected row, profile footer, and composer proportions align with the reference. Mobile keeps a horizontal agent strip and maintains usable control sizes.
- Colors and tokens: the implementation uses Fable's existing neutral surface, line, hover, and ink tokens rather than introducing a parallel palette.
- Image and icon quality: existing uploaded-image avatars remain supported. Agent marks and controls use the existing agent artwork and Phosphor icon library; no placeholder or handcrafted image assets were introduced.
- Copy and content: the workspace name, `Preview workspace`, `Agents`, `New agent` text label, and `Ctrl K` badge are not visible. `New agent` remains the accessible name for the plus control.

## Interaction and accessibility checks

- Search opens and closes the workspace search dialog.
- The top-right plus opens the agent editor.
- The live-work control opens and closes the work rail.
- The compact composer add control opens and closes its menu.
- The composer exposes exactly one right-hand primary action: microphone for empty and whitespace-only drafts, send for meaningful text, and the appropriate stop action during active work.
- Empty and typed actions occupy the same 34 px desktop slot and the same 44 px mobile touch target.
- Focus-visible styling remains inherited from Fable's shared controls.
- Desktop and mobile captures show no overlap or horizontal overflow.
- Browser console errors: none.

## Comparison history

1. Initial pass: the header avatar was oversized, the 900 px sidebar collapsed to 264 px, the mobile plus was only 30 px, and the composer was 112 px high. Result: blocked by P2 fidelity and touch-target differences.
2. Fixes: reduced the header mark to 22 px, held the reference viewport sidebar at 280 px, raised the mobile plus to 40 px, hid the profile gear until hover/focus, and converted the agent composer to a 52 px single-line layout with reference-like gutters. Post-fix evidence: final desktop and mobile captures above. No actionable P0, P1, or P2 findings remain.
3. Adaptive-action pass: replaced the simultaneous microphone and send controls with one intent-aware slot. Browser evidence confirms empty → microphone, typed → send, cleared/whitespace-only → microphone, with no layout shift or horizontal overflow. No actionable P0, P1, or P2 findings remain.

## Follow-up polish

- P3: the local preview contains only one agent and no conversation history, so its content density cannot reproduce the populated example without inventing product data. Existing real agents and conversations will fill these regions naturally.

final result: passed
