# Conversational UI visual verification

final result: passed for the inspected native layouts

Source visual truth: `output/conversation-upgrade/openui-design-reference.png`.
Generated from the real signed-in native Mivlet screenshot
`output/conversation-upgrade/native-openui-output-restored.png`.

The reference preserves Mivlet's sidebar, image avatars, conversation, composer
and output pane. The implementation uses the existing fonts and semantic tokens,
sage/violet comparison cards, selected option cards, labelled form fields,
bounded tables, data-driven chart bars, checklists and an editorial output pane.
Phosphor icons remain the established icon library. Existing logo and agent
images remain the production assets. No decorative raster assets are required.

Intentional data constraints: labels, prose, values and available revisions come
from saved provider results. The reference's illustrative statistics, drink
icons and historical revision rows are not invented in the production response.
Revision history retains progressive disclosure and native persistence.

The reference and the implemented 1442 × 1026 native window were inspected
together. `native-openui-refined-wide.png` shows the saved Tea/Afternoon reading
controls beside the fourth output revision. The typography, semantic card colors,
form hierarchy and reading width follow the reference using real saved content.
The catalogue's table/chart remain vertically stacked, and the revision selector
retains progressive disclosure instead of inventing the reference's sample rows.
This is a design comparison, not a claim of pixel-for-pixel reproduction.

At 763 × 1026, `native-openui-refined-narrow.png` and
`native-output-refined-narrow.png` show bounded generated controls and the output
drawer. `native-openui-refined-dark.png` covers the dark palette. Native inspection
found a fit-content/inline-size containment interaction that collapsed generated
responses in the narrow side chat. The explicit bounded-width fix is verified
in the main conversation at both sizes and in the separate 763-pixel side-chat
drawer. `native-openui-sidechat-final.png` shows the saved Tea selection and
Afternoon reading field at readable width. Escape closes the drawer and restores
visible keyboard focus to the workspace-panel control.

The 30-row, six-column table was inspected in both sizes. The captures
`native-large-table-refined-wide.png` and
`native-large-table-refined-narrow.png` show its internal scrolling, sticky
headers and accessible composer. Narrow approval previews were also inspected.
The user subsequently selected dark appearance; that latest preference is retained.

The official MCP example renders and its one-use action was denied and then
approved through the actual native host. Its dock transition exposed a session/
resource race and competing focus traps, both corrected. The final native recheck
shows the original saved timestamp in the panel without a tool replay
(`native-mcp-docked-ready.png`). Its exact resource/action approval stays in the
owning drawer above the app (`native-mcp-docked-approval.png`); denial removes the
proposal and leaves the saved result unchanged. Security probe and build evidence
remain separate from this visual result.

The final production-assets inspection caught an additional build-only defect:
CSS imports were expanded after class-name compaction. The shared compactor fix
now transforms the expanded stylesheet before emission. Native dark appearance,
composer controls and table styling were rechecked using the production build,
not Vite's development transforms (`native-production-mcp-inline.png`).

The production MCP recheck covers its docked saved timestamp, fresh resource
approval and Return to conversation without an orphaned tab. At 763 × 1026,
`native-production-narrow-approval.png` and `native-production-narrow-app.png`
show the actual modal drawer. Resizing originally remounted the conversation;
the pane grid now retains its DOM across the breakpoint. The initialized app
survived maximizing and restoring the window, and Close removed the app tab.
The mounted-pane regression also checks draft text, focus, selection and scroll
retention. A subsequent connector disconnect showed explicit Close and reconnect
recovery (`native-production-app-recovery.png`); closing and Escape returned to
the conversation (`native-production-app-closed.png`).

Required comparison evidence:

- Match the wide native window, selected Tea/Afternoon reading response and open
  output pane to the reference. Record actual pixel dimensions and density.
- Open both images in the same comparison input, then inspect focused generated
  controls and output-history regions.
- Inspect a narrow native window, large table, dark theme and pending approval.
- Evaluate fonts/typography, spacing/layout, semantic colors, asset quality and
  truthful copy/content. Check focus, selection, scrolling and touch targets.
- Fix any P0/P1/P2 issue and capture the same state again before a passing result.

No visual acceptance claim is made from build success or HTTP health.
