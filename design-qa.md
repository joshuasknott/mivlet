# Fable Design QA

## Evidence

- Corrected concept: `docs/design/fable-ui-concept.png`
- Before, desktop: `docs/design/qa/fable-before-1440x1024.png`
- Before, narrow: `docs/design/qa/fable-before-390x844.png`
- After, desktop: `docs/design/qa/fable-after-1440x1024.png`
- After, connectors: `docs/design/qa/fable-after-connectors-1440x1024.png`
- After, narrow: `docs/design/qa/fable-after-390x844.png`
- Verified viewports: 1440 × 1024 and 390 × 844

## Result

Passed.

- Fable lockup sits above the workspace selector; navigation labels, order, hierarchy, and responsive grouping are preserved.
- Inter is the only loaded UI family. Weights are restricted to 400, 500, 600, and 700.
- The warm surface, graphite ink, copper interaction accent, approved radii, elevation, and blur values come from central tokens.
- Active navigation and tabs use copper text, copper-subtle fill, and copper underline where applicable.
- Positive, caution, and destructive colors are reserved for status and destructive actions; connector brand colors remain confined to provider marks.
- Onboarding, home/composer, Connectors, Knowledge, Schedules, Profile, Settings, account menu, mobile navigation, and narrow-window composer were inspected.
- The schedule create/delete flow and Settings tab interaction were exercised in the browser.
- No horizontal overflow, clipped primary controls, stale branding, or framework overlays remain in the verified states.

## Compatibility

- `com.arden.workspace` is intentionally retained as the Tauri application identifier.
- `arden.shell.v1` and `praxis.shell.v1` are read-only migration fallbacks for `fable.shell.v1`.
- `arden://backend/` and `arden.memory.export.v1` remain stable runtime/export contracts.
