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
