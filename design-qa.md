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

final result: passed
