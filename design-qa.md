**Design QA**

- Source visual truth:
  - `C:\Users\Josh\.codex\generated_images\019f10ed-808a-7c71-892a-ddd3be7fe5c0\call_2owEKSz07xfUgvY4UTCNRQeH.png`
  - `C:\Users\Josh\.codex\generated_images\019f10ed-808a-7c71-892a-ddd3be7fe5c0\call_IlNExSNlldvc3wNCm8OygkBZ.png`
- Implementation screenshot:
  - `C:\Users\Josh\Projects\fable\output\design-qa\knowledge-page-1440x1024.png`
- Combined comparison:
  - `C:\Users\Josh\Projects\fable\output\design-qa\knowledge-comparison.png`
- Viewport: 1440 x 1024
- State: Sources selected, section-scoped search, newest-first sort, pinned filter off, empty workspace.

**Full-View Comparison**

- The implementation follows option 1 for the main structure: page title, one dominant search, three sections, one compact filter row, and one list surface.
- The section navigation takes visual weight from option 2 through wider targets, supporting descriptions, counts, and a stronger active underline, but remains materially smaller than option 2.
- The current Fable sidebar is unchanged. Its live workspace content differs from the generated examples by design.
- The generated references contain sample source rows. The live workspace has no saved sources, so the implementation shows the intended empty state. Imported row behavior and expansion are covered by the Knowledge interaction tests.

**Focused Region Comparison**

- Search and section navigation were checked at full resolution in the combined image. A separate crop was not needed because typography, controls, spacing, dividers, and active states remain readable at 1440 x 1024.

**Required Fidelity Surfaces**

- Fonts and typography: Inter and the existing Fable type scale are preserved. The page title intentionally follows the live product's 30px page heading instead of the larger generated heading.
- Spacing and layout rhythm: Search, section navigation, toolbar, and list/empty state align to one content column with consistent dividers and no nested cards.
- Colors and visual tokens: The warm canvas, graphite text, muted secondary text, and sparse copper active state use existing Fable tokens.
- Image and asset fidelity: The page needs no custom imagery. All visible controls use the existing Phosphor icon library.
- Copy and content: Labels are plain and short. Technical provenance and maintenance controls are hidden until an item is opened.

**Findings**

- No actionable P0, P1, or P2 mismatches remain.

**Patches Made**

- Increased section prominence between the two selected mockups.
- Added global and section search scopes.
- Added functional pin filtering and newest/oldest sorting.
- Moved import, connector, source maintenance, and memory editing actions behind progressive disclosure.
- Removed the source inspector and suppressed memory-only status from Sources and global results.
- Darkened active controls and added a restrained copper section state.

**Follow-up Polish**

- P3: Recheck row density with a large real dataset once artifact persistence is connected.

final result: passed
