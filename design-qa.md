# Design QA

## Comparison target

- Source visual truth:
  - `C:\Users\Josh\.codex\attachments\6b5205b2-1a8a-4a23-8200-6c8e8bfec543\image-1.png`
  - `C:\Users\Josh\.codex\attachments\6b5205b2-1a8a-4a23-8200-6c8e8bfec543\image-2.png`
  - `C:\Users\Josh\.codex\attachments\6b5205b2-1a8a-4a23-8200-6c8e8bfec543\image-3.png`
- Primary implementation screenshot:
  - `C:\Users\Josh\Projects\fable\output\design-qa\workspace-light-final.jpg`
- Combined comparison:
  - `C:\Users\Josh\Projects\fable\output\design-qa\cursor-light-workspace-comparison-final.jpg`
- Additional evidence:
  - Desktop onboarding: `output\design-qa\.playwright-cli\page-2026-07-02T00-48-40-698Z.png`
  - Desktop provider grid: `output\design-qa\.playwright-cli\page-2026-07-02T00-49-15-340Z.png`
  - Mobile onboarding: `output\design-qa\.playwright-cli\page-2026-07-02T00-50-04-177Z.png`
  - Mobile provider grid: `output\design-qa\.playwright-cli\page-2026-07-02T00-50-37-056Z.png`
  - Mobile workspace: `output\design-qa\.playwright-cli\page-2026-07-02T01-00-36-381Z.png`
  - Mobile settings drawer: `output\design-qa\.playwright-cli\page-2026-07-02T00-54-30-160Z.png`
  - Desktop dark settings: `output\design-qa\.playwright-cli\page-2026-07-02T00-55-15-860Z.png`
  - Tablet workspace: `output\design-qa\.playwright-cli\page-2026-07-02T01-00-59-335Z.png`
- Viewports: 1440x900, 800x700, and 390x844.
- States: onboarding profile/provider, empty workspace, settings general/history, Departments, light and dark themes.

## Full-view comparison

Fable now follows the supplied Cursor references in overall density and composition: a flat 212px sidebar, neutral canvas, restrained selection fills, compact type, sparse borders, a centered low-profile composer, and minimal elevation. The product-specific tools and labels remain Fable's rather than cloning Cursor's information architecture.

## Focused comparison

The sidebar and composer were compared together at matched 900px height in the combined image. Settings was checked separately against the supplied Back/Search Settings crop. Onboarding and provider cards were checked at desktop and phone widths because their text, controls, and brand marks were too small to judge reliably in the full workspace comparison.

## Required fidelity surfaces

- Fonts and typography: Inter is bundled at 400/500; UI sizes, weights, line heights, wrapping, and hierarchy are compact and consistent across themes.
- Spacing and layout rhythm: the shell uses a flat 212px rail, 100dvh sizing, compact rows, a 640px composer, and one mobile drawer breakpoint without an icon-only intermediate rail.
- Colors and visual tokens: light and dark themes use neutral Cursor-like greys; light is the first-run default; status colours and authentic provider colours remain semantic exceptions.
- Image and asset fidelity: the UI contains no decorative raster imagery. Provider and connector marks use real brand paths/colours; monochrome marks adapt for dark contrast.
- Copy and content: redundant onboarding exits and credential-boundary card are gone; settings labels are consolidated; Departments is explicitly unavailable; history distinguishes Runs from Activity.
- Accessibility and behavior: responsive screenshots show no clipping at tested viewports; Back/Forward, settings search, provider actions, tabs, theme controls, and mobile drawer were exercised; console error/warning checks were clean.

## Findings

No actionable P0, P1, or P2 visual mismatches remain.

## Patches made since the audit

- Repaired provider-card text collision and mobile header clipping found during the first QA pass.
- Made settings Back visible on mobile and kept Search Settings inside the drawer.
- Reduced the workspace heading to a small context label so the composer matches Cursor's visual weight.
- Moved empty Projects and Chats into one compact navigation area.
- Made black/white provider marks theme-aware.
- Updated changed UI contracts in the app and settings tests.

## Follow-up polish

- P3: Replace the preview-only onboarding skip when the production onboarding completion path is finalized.
- P3: Revisit provider descriptions with real connected-account data to determine whether Settings can become even denser.

## Frontend optimization QA (branch `codex/frontend-optimization`)

A dedicated frontend optimization pass (React render stability, bundle size,
layout performance, and a small Schedules information-density cleanup) was
verified with the package-level suite plus a real-browser pass against the
local dev server (Playwright/Chromium). No backend or src-tauri files were
touched.

### Checks

- `pnpm --filter @fable/desktop typecheck` — PASS
- `pnpm --filter @fable/desktop test` — 341 passed / 12 failed (353 total)
  - The 12 failures are pre-existing on the baseline (`6ae1a68`) and relate to
    the earlier UI reorganization (nav "Projects"/"Josh's Fable" heading,
    connector "Connect" button, onboarding "Add API key" button). None are
    caused by this optimization pass; the count is unchanged from baseline
    (one new test was added for the Schedules live summary).
- `pnpm --filter @fable/desktop build` — PASS

### Bundle: before vs after

Baseline shipped a single 699.74 kB JS chunk (gzip 194.73 kB) over the 500 kB
warning. After route-level `React.lazy` + vendor `manualChunks` + esnext target:

| Chunk | Before | After |
|---|---|---|
| index (initial app) | 699.74 kB (gzip 194.73) | 226.76 kB (gzip 65.80) |
| react-vendor | (in index) | 188.72 kB (gzip 59.01) |
| icons | (in index) | 161.68 kB (gzip 35.10) |
| SettingsPage (lazy) | (in index) | 52.82 kB (gzip 13.19) |
| SchedulesPage (lazy) | (in index) | 15.47 kB (gzip 4.68) |
| KnowledgePage (lazy) | (in index) | 13.42 kB (gzip 3.61) |
| OnboardingPage (lazy) | (in index) | 11.10 kB (gzip 3.40) |
| ConnectorsPage (lazy) | (in index) | 7.90 kB (gzip 2.64) |

No chunk exceeds the 500 kB warning. Lazy pages load on demand; vendor chunks
are cacheable across app changes. Inter fonts scoped to latin + latin-ext
(28 → 8 font files; unused cyrillic/greek/vietnamese subsets dropped).

### Render / layout

- Composer typing no longer triggers a per-keystroke localStorage write and
  Rust snapshot save (both debounced, with an unmount flush so drafts/schedules
  still persist exactly).
- Hot derivations memoized (openApprovals, connector cards/ids, recoverable
  runs, model chip label, settings/sidebar tab filters, provider lists).
- Scheduled-agent runner options held in a ref (mirrors useNativeAgent) so its
  drain effect no longer re-evaluates every render; global shortcut listener
  subscribes once.
- Replaced the only literal `backdrop-filter: blur()` (always-visible reopen
  card) with the `--glass-filter` token; enumerated `transition: all` on
  onboarding buttons; added overflow/ellipsis truncation to model/permission
  chips and connector/schedule/backend titles; layout containment on repeated
  rows; stable height on the workspace-settings modal; submenu clamp in the
  701–980px band.

### Schedules cleanup

The create/edit form now shows a single live recurrence summary
("Weekly on Mon, Wed at 9:00 AM · Next …") reusing `summarizeRecurrence`, so
the previously split Repeat/Frequency/Time/Weekdays readback is consolidated.
List pattern + next-run grouped into one timing block. Scheduler logic,
validation, data shapes, and accessibility labels are unchanged.

### Browser QA (Playwright/Chromium, dev server)

Viewports: 1440x900, 800x700, 390x844. Surfaces exercised: onboarding gate
(lazy), empty workspace + composer typing, model menu, add menu, settings
modal + search (lazy), Knowledge (lazy), Connectors (lazy), Schedules with the
cleaned-up summary (lazy), mobile workspace. Console errors: none. Page
errors: none. No text clipping, control overlap, broken menus, or blank
lazy-loaded pages observed. Evidence: `qa-shots/*.png` in the worktree.

final result: passed

## Onboarding and schedules merge QA (2026-07-02)

### Comparison target

- Source visual truth:
  - `C:\Users\Josh\AppData\Local\Temp\codex-clipboard-737b2f70-2e73-483b-8276-88505609dd81.png`
  - `C:\Users\Josh\AppData\Local\Temp\codex-clipboard-822a7295-4a7b-4060-9121-4a0e7d3dfdc6.png`
- Implementation screenshot:
  - `C:\Users\Josh\AppData\Local\Temp\fable-schedule-modal.png`
- Combined focused comparison:
  - `C:\Users\Josh\AppData\Local\Temp\fable-schedule-comparison.png`
- Additional implementation evidence:
  - `C:\Users\Josh\AppData\Local\Temp\fable-onboarding-profile.png`
  - `C:\Users\Josh\AppData\Local\Temp\fable-provider-grid.png`
  - `C:\Users\Josh\AppData\Local\Temp\fable-api-key-chooser.png`
  - `C:\Users\Josh\AppData\Local\Temp\fable-provider-setup.png`
  - `C:\Users\Josh\AppData\Local\Temp\fable-workspace-composer.png`
  - `C:\Users\Josh\AppData\Local\Temp\fable-schedules-page.png`
  - `C:\Users\Josh\AppData\Local\Temp\fable-schedule-modal-mobile.png`
- Viewports: 1280x720 and 390x844.
- States: onboarding profile, provider grid, API-key provider chooser, API-key entry,
  workspace composer, empty schedules page, and new scheduled task modal.

### Full-view comparison

The schedules page preserves the reference hierarchy: one compact title/action
row, a search field directly beneath it, and a modal-led creation flow. The
scheduled-task modal matches the reference's Name, Schedule, and Prompt rhythm
while intentionally using Fable's light/dark tokens and excluding Project and
Flash-specific copy.

The onboarding pass now uses the desktop canvas rather than a narrow centered
column. Provider logos are the dominant tile content and API-key setup is a
separate modal flow instead of an expanded secondary grid.

### Focused comparison

The scheduled-task modal was cropped to the same 640px content width as the
reference and placed in one combined comparison image. The implementation keeps
the source's alignment, field order, compact Daily/at/time row, prompt height,
close placement, and bottom-right disabled action. Its shorter height is the
expected result of removing the explicitly excluded Project and Flash rows.

### Required fidelity surfaces

- Fonts and typography: Inter remains the application font; the modal preserves
  the reference's compact label hierarchy and readable control sizing.
- Spacing and layout rhythm: title, fields, schedule row, prompt, and action use
  the same top-to-bottom rhythm as the reference without the removed sections.
- Colors and visual tokens: all surfaces and states use existing Fable tokens;
  the reference colour scheme was intentionally not copied.
- Image and asset fidelity: provider marks use the existing real ProviderIcon
  assets at larger sizes; UI actions use Phosphor icons.
- Copy and content: Project and Flash copy are absent; the API-key offer is now
  “Prefer direct provider access? Add an API key.”
- Accessibility and behavior: dialogs are labelled and modal, Escape/backdrop
  close works, focus is restored, schedule fields are keyboard-accessible, and
  the API key remains outside React state.

### Findings

No actionable P0, P1, or P2 mismatches remain.

### Patches made during QA

- Moved API-key provider selection into its own icon-first modal.
- Centred and enlarged provider branding in tiles and setup dialogs.
- Corrected CSS cascade ordering that kept the desktop profile form at 420px.
- Replaced the nested recurrence form with a compact progressive schedule row.
- Removed the schedules description line to match the sparse reference header.
- Increased composer control sizing without changing the composer container.
- Increased sidebar text sizing, softened Threads/Chats, and replaced the New
  chat plus glyph with the NotePencil icon.
- Updated stale App integration tests for the modal schedule flow.

### Verification

- `pnpm --filter @fable/desktop typecheck` — passed.
- `pnpm --filter @fable/desktop test` — 360 passed.
- `pnpm --filter @fable/desktop build` — passed.
- Browser console errors/warnings for tested flows — none.

final result: passed

## Marketing page QA (2026-07-04)

### Comparison target

- Source visual truth:
  - `C:\Users\Josh\.codex\generated_images\019f2a7d-2c89-7bf3-b48c-85c90e7d18b2\ig_0a10ca53dfea0ee0016a485b25a4c48191a41b0d89a2f40129.png`
- Implementation screenshot:
  - `C:\Users\Josh\Projects\fable\output\playwright\marketing-home-full.png`
- Combined comparison:
  - `C:\Users\Josh\Projects\fable\output\playwright\marketing-design-comparison.png`
- Viewport: 1440x1100, full-page capture.
- State: marketing home, default state.

### Full-view comparison

The implementation preserves the selected mockup's black-and-white visual
system, large Fable dragon lockup, strong hero typography, grayscale horizon
light, local-first/open-source product framing, connector ecosystem, and
product updates section.

Later user direction intentionally moved providers out of the hero into a
dedicated rail directly below it, removed Hugging Face, removed icon cards,
required real provider and connector icons, and added automatic and manual
horizontal rail movement.

### Focused comparison

The hero, provider rail, connector rail, and update form are readable in the
full-page comparison. Desktop and mobile screenshots were reviewed
independently for text overlap, asset transparency, responsive hierarchy, and
rail clipping.

### Required fidelity surfaces

- Fonts and typography: hierarchy, wrapping, line height, and weights remain
  legible at desktop and mobile sizes.
- Spacing and layout rhythm: hero, section rhythm, rails, product pillars, and
  update form maintain consistent alignment.
- Colors and visual tokens: the implementation uses a strict black, white, and
  grayscale token system.
- Image and asset fidelity: the Fable dragon has a transparent background;
  Codex, OpenCode, provider, and connector icons use local real SVG assets
  rendered in grayscale.
- Copy and content: Windows preview language and Hugging Face are absent from
  the marketing implementation.
- Accessibility and behavior: the rails auto-scroll, support pointer/touch
  scrolling and manual drag, remain keyboard-focusable, and disable animation
  for reduced-motion preferences.

### Findings

No actionable P0, P1, or P2 findings remain.

### Patches made during QA

- Rebuilt the home page from the selected third mockup direction.
- Added the transparent Fable technology-dragon asset.
- Added local provider and connector SVG assets.
- Moved providers below the hero.
- Converted provider and connector groups into transparent, one-line,
  auto-scrolling, manually draggable rails.
- Added smooth light-horizon animation and responsive layouts.
- Updated waitlist copy and static marketing tests.

### Follow-up polish

- P3: A future brand pass can replace the generated raster dragon with a
  production vector master while preserving the current silhouette.

final result: passed
