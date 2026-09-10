# Mivlet UI polish verification — 9 September 2026

Status: implemented; final repository gates pass. Live UI, provider and native acceptance remain limited to the evidence below.

## Changes

- Neutral palette, consistent modal typography and spacing, compact window controls and separate computer toggle.
- Collapsible agent navigation; direct conversations omit repeated author/avatar chrome and redundant welcome identity.
- Schedules moved from Settings to the agent/project options menu, with agent filtering and keyboard focus restoration.
- Settings and plugin dialogs implemented from generated references using existing application components and actual connector capability data.
- Connected plugin examples prepare composer text without sending it. Unconnected examples remain disabled.

## Visual evidence

Evidence is in `output/design-polish/` (local ignored artifacts). References: `settings-reference.png`, `plugin-reference.png`. Captures: `conversation-desktop-dark.png`, `settings-desktop-dark.png`, `settings-general-desktop-dark.png`, `settings-mobile-light.png`, `plugin-desktop-dark.png`, `plugin-mobile-dark.png`, `schedules-mobile-light.png`.

Compared the modal regions, normalizing by modal width rather than the generated backdrop. Settings implementation is 920 x 680 on a 1440 x 1000 viewport. Plugin desktop capture is 1094 x 1270 with a 720px modal; phone checks use 390 x 844. References are 1504 x 1046. Reviewed hierarchy, typography, palette/contrast, spacing/alignment and responsive behavior. Existing brand icons and actual settings/connection data intentionally replace generated content. The generated connection/access promises were not treated as product capabilities.

Observed clean light/dark settings, desktop navigation, empty conversation, computer panel open/close, phone plugin scrolling and phone schedules. Iteration fixes included bordered tool-server fields, sticky plugin close control, larger original plugin icon, and focus return when closing the computer rail. The desktop plugin screenshot predates the final 28px icon and chevron refinement. Native window actions and live OAuth/schedule execution were not tested by browser fixtures.

## Checks

- Full desktop suite passed earlier: 83 files, 596 tests.
- Final focused regression suite passed: 5 files, 28 tests (including the newly added navigation test).
- Repository quality gate and focused lint passed before concurrent runtime migration changes.
- Final TypeScript/Vite and production builds passed in the later runtime verification. This record does not claim live provider/OAuth execution or deployed acceptance; those remain separately unverified.
- The later runtime verification included the current performance/bundle gate without raising budgets. This UI record does not claim a fresh UI-only bundle measurement.
- Final git diff --check passed (line-ending normalization warnings only).

Reviewable UI work and captured evidence are preserved. No commit, push, deployment or live provider/OAuth acceptance is claimed.
