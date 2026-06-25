source visual truth path: `docs/design/praxis-selected-concept.png`

implementation screenshot path: `output/qa/praxis-home-1440x1024-v6.png`

viewport: `1440 x 1024`

state: default Praxis home screen, Chats/Projects sidebar visible, `Praxis desktop > Initial build` selected, composer empty.

mobile screenshot path: `output/qa/praxis-home-390x844-v6.png`

browser verification: in-app browser at `http://127.0.0.1:1420/`.

**Findings**

- No P0/P1/P2 findings remain for the current requested navigation update.

**Required Fidelity Surfaces**

- Fonts and typography: the implementation keeps the reference's serif editorial headline with Newsreader and uses Inter for UI chrome. The heading remains one line at the target desktop viewport and wraps cleanly on mobile.
- Spacing and layout rhythm: the central composer and directive stack remain aligned with the selected concept. The sidebar is intentionally lighter than the reference, per the latest user request, and uses Chats/Projects groupings instead of destination-heavy nav.
- Colors and visual tokens: the implementation uses the requested Cursor-like graphite/off-white palette with restrained green accents.
- Image quality and asset fidelity: the in-app Praxis mark remains a CSS-rendered approximation for this slice; Tauri has a generated local icon for packaging. This is acceptable for the current UI slice but should become a finalized brand asset later.
- Copy and content: Home, Threads, and Goals are removed from the sidebar. Chats and Projects now contain nested threads. Knowledge, Plugins, and Automations remain secondary tools. The prompt cards remain single-click composer starters.
- Responsive behavior: the 390 x 844 viewport keeps the composer visible and has no horizontal overflow after replacing `100vw` app sizing with percentage width.

**Patches Made Since Previous QA Pass**

- Replaced large destination-style sidebar buttons with lightweight sectioned navigation.
- Added `Chats` with non-project threads.
- Added `Projects` with nested project-specific threads.
- Kept `Knowledge`, `Plugins`, and `Automations` as quieter workspace tools.
- Preserved merged Josh/settings account row.
- Added focused views for Knowledge, Plugins, Automations, and Memory/Approvals without introducing a right nav.
- Added local draft, pinned source, automation status, and approval audit persistence.
- Updated tests to verify the new hierarchy, composer starters, slash command entry, knowledge inspection, approval audit, and draft recovery.

**Implementation Checklist**

- TypeScript check passed.
- Interaction tests passed.
- Production build passed.
- Tauri/Rust check passed.
- Browser verification confirmed prompt cards fill the composer.
- Browser verification confirmed `/goal` writes into the composer.
- Browser verification confirmed Knowledge opens sources and memory.
- Browser verification confirmed denying a GitHub approval removes it and writes audit history.
- Browser verification confirmed enabling a draft automation routes to composer and approval review.

**Follow-up Polish**

- Finalize Praxis logo as a proper generated or vector brand asset instead of CSS construction.
- Add collapsible sidebar density states for smaller windows.
- Add live sections for recent chat/project sorting once real workspace data exists.
- Replace fixture connector/auth states with live local files, GitHub, Convex, and OAuth-backed integrations.

final result: passed
