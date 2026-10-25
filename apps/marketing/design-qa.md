# Mivlet marketing design QA

## 2026-10-19 marketing clarity and manual agent selection

Final result: passed locally. This revision has not been deployed.

- Preserved the warm background, centred headline, ribbon, typography, all six original characters, lavender workspace and peach project/composer surfaces. Compact yellow/blue cards directly below the hero now show a prompt and a real excerpt from the matching example document; the old full-size snippet section and introductory welcome dialog are removed.
- Demo CTAs lead directly to the workspace. Windows setup links point to the repository's Development section, with experimental/source-release status visible before clicking. Provider costs, connection prerequisites, local storage, credential custody and approvals are explained visibly.
- The main scene opens on its completed result. Agent changes happen only through selection, play once and hold. The orange composer types only the selected example and preserves custom drafts. No pause/replay controls or countdown line. The separate project/plugin illustrations retain their existing sequences.
- Inspected desktop at 1200px, tablet at 768px, and mobile at 390px and 320px. No page overflow; mobile agents use one scrollable row. Verified direct demo links, menu navigation, keyboard End selection/focus, full five-item right rail, example dialogs/focus recovery, custom-draft restoration and honest custom-prompt setup routing.
- Verified the finished initial result in both the production build and React StrictMode development preview. Fixed duplicate mount effects seeking to frame zero. Refreshed the pre-existing Vite dependency cache after stale optimized icon requests; final delivery uses the built preview on port 4177.
- Independently reviewed the selection lifecycle and hero result/document consistency. Production build, all four hosting/packaging tests, formatting and `git diff --check` passed. Screenshots are in `output/marketing-improvements-2026-10-19/`: `desktop-hero.png`, `desktop-demo.png`, `mobile-320.png`, `mobile-demo.png`, `mobile-trust.png` and `mobile-setup.png`.
- Browser viewport emulation only; no physical-device, installer, provider-account or new live-deployment acceptance is claimed. Historical release notes below describe earlier deployed revisions.

## 2026-10-19 complete right navigation

- Published deployment `dpl_2ibdVNyVjoSS9qjp2KfJMNB9r6Lb` (READY) to `https://mivlet-marketing.vercel.app`. Anonymous HTTP checks returned 200 and exact build hashes for HTML and all six JS/CSS chunks. Live browser confirms all five rail items and no console errors. Evidence: `output/rightnav-complete-live.jpg` and `output/rightnav-complete-320.jpg`. Responsive checks use browser viewport emulation, not physical devices.
- Added Side Chat and Schedules after Memory in every agent scenario, matching the current desktop `WorkspaceRightNav.tsx` order and its regular 22px `ChatsCircle` and `CalendarBlank` icons. This supersedes the earlier request to omit Schedules.
- Preserved the entire five-item rail on tablet and mobile. Narrow layouts collapse the Activity content pane, matching the current app's persistent 64px rail. Expanded the mobile composition and its matching loading placeholder to 320 x 640; tightened composer spacing to keep the full model label on one line and the result above it.
- Checked desktop, tablet and phone layouts at 1280, 768, 390 and 320px. All five rail labels fit and the page has no horizontal overflow. Production build, four hosting/packaging tests and whitespace checks passed.

## 2026-10-19 control parity, pacing and collaboration redesign

- Used built-in Imagegen with the user's project screenshot and actual six-character artwork. Reference: `output/projects-collaboration-v3.png`; exact prompt: `output/projects-collaboration-v3-prompt.txt`.
- Compared the generated reference and `output/projects-v3-desktop-final.jpg` together. Kept the peach surface, six attributed conversation contributions, shared brief, character strips and stacked mobile layout. Adaptations: real app artwork/icons, role labels instead of invented timestamps, readable brief text instead of skeleton bars, and the site's existing typography.
- Grounded remaining controls against the current desktop `AgentSidebar.tsx`, `Composer.tsx`, `ModelPicker`, `WorkspaceRightNav.tsx`, `MessageAttachments.tsx` and related CSS. Matched search/new-chat/folder sizing, the exact custom Plugins icon, overlapping connected-app marks, Activity/Files/Memory rail geometry, file cards, 19px microphones and flat 32px send circles with regular 20px arrows. The editable orange form intentionally keeps its model label without an unwired picker caret.
- Main scenes now last 10 seconds with a 333ms crossfade and completed output at about five seconds. Plugin output arrives at 3.6 seconds. Project contributions start immediately and assemble the brief within six seconds. Orange typing and section entry are quicker; no replay, pause or reduced-motion modes were added.
- Removed the snippets' first-frame flash of completed content. Suspended offscreen players from initial mount, paused snippets with dialogs, memoized recurring agent artwork/sidebar, and stopped plugin React updates during unchanged reading holds. Direct Phosphor imports reduce the build transform from 4,594 modules to 100; this is build evidence, not a measured production FPS claim.
- Mobile project text is now native CSS size rather than a scaled canvas. Responsive measurement follows the mounted scene and its natural height; removed flex stretching that retained excess white space after resizing. Desktop brief sections distribute space and anchor readiness at the bottom.
- Kept the Projects heading/anchor outside the lazy animation chunk and restore initial fragment navigation after page load. Production-preview reload at `/#projects` now lands on the section rather than the page top.
- Live cold-load inspection caught two further startup issues: the mobile placeholder used the desktop aspect ratio, shifting the Projects anchor after loading; and Remotion's default unmuted audio context waited for a user gesture, holding silent demos at frame zero. Matched placeholder breakpoints and set all Players to `initiallyMuted` with zero shared audio tags. A fresh production-preview load then progressed without clicks or scrolling. Project playback also resynchronizes when its Player ref becomes available.
- Inspected 320, 390, 768 and 1280px browser viewports. No horizontal overflow or missing loaded images found. Exercised manual agent selection, automatic progression, progress reset, plugin document opening/Escape/focus restoration, orange selection/automatic continuation and exact custom-draft restoration. The production-preview console was clean; a development-only Fast Refresh warning occurred while changing hook dependencies and did not recur in the production build.
- Evidence: `output/projects-v3-320.jpg`, `output/projects-v3-tablet.jpg`, `output/projects-v3-desktop-final.jpg`, `output/projects-v3-production-mobile.jpg`, `output/desktop-composer-final.jpg`, `output/composer-320.jpg`, `output/plugins-controls-320.jpg`, and `output/orange-controls-320.jpg`. Screenshots show natural animation frames, not synchronized frozen frames.
- Production build/Sites packaging, all four hosting tests, independent source review and `git diff --check` passed. Browser checks used viewport emulation; no physical-phone or live-agent acceptance is claimed. Deployment verification is recorded below after publication.
- Final deployment: `dpl_FDr9AcK61u47DiSpFrgiPBFd81Q4`, READY at `https://mivlet-marketing.vercel.app`. Anonymous HTTP returned 200 and exact SHA-256 matches for the tested HTML, all six JS/CSS chunks, favicon and character sprite. No protection settings were changed.
- Final live checks confirmed stable mobile fragment positioning, 13px native project-message text, no horizontal overflow, and cold-load animation progression without user interaction. The project advanced from Nova alone to all six contributors and a completed brief; the main demo's progress advanced immediately on a fresh `/#product` load. The live console contained no errors. Evidence: `output/projects-v3-live-desktop.jpg` and `output/projects-v3-live-mobile.jpg`.

Final result: passed locally and on the public production site.

## 2026-10-19 send icon correction

- Matched the workspace send action to the current desktop app: a flat 32px circle with a regular 20px arrow. Reset native appearance, padding, border and shadow; the orange composer button also explicitly resets native appearance and padding.
- Inspected the composer on desktop and at a 390px mobile viewport. Computed arrow and button centres match, with no native border or padding. Browser emulation only; no physical-device acceptance is claimed.
- Production build, all four hosting/packaging tests and `git diff --check` passed.
- Redeployed the existing production project as `dpl_C5377F2E5m23bnxHkZf4osNmGsX9` (READY). Anonymous HTTP checks returned 200 and exact build hashes for HTML and all seven JS/CSS chunks. Confirmed the corrected dimensions and appearance in the live browser. Evidence: `output/send-icon-live.png`.

## 2026-10-19 mobile polish and six-agent revision

Final result: passed locally and on the public Vercel deployment. This revision supersedes the three-agent and overflow-menu details in the historical notes below.

- Inspected the public site at `https://mivlet-marketing.vercel.app` before editing. Saved `output/mobile-before.png` and `output/welcome-mobile-before.png`.
- Used built-in Imagegen before implementation. References: `output/welcome-direction-v2.png` and `output/agents-projects-direction-v2.png`; exact prompts are saved alongside them as `welcome-prompt-v2.txt` and `agents-projects-prompt-v2.txt`.
- Compared both references with implementation screenshots in the same visual inspection. Preserved their hierarchy, character-led welcome, lavender agent surface, peach collaboration section, attributed assignments and shared result. Intentional adaptations: actual app sprite artwork and composer; Activity/Files/Memory instead of the generated Context/ellipsis; a wider project surface for readable text; responsive layouts instead of decorative phone chrome. Mobile welcome characters use a tidy three-by-two arrangement.
- Browser title is now simply Mivlet, with the desktop app's actual 64px favicon.
- Six original character forms appear as Nova, Sage, Kit, Otto, Fern and Pip. Both the main demo and orange prompt composer cycle through all six and retain manual selection. Each added scenario has its own prompt, response and document.
- Separate Remotion project demo shows all six agents moving through queued, working and completed assignments, then combines their work into a launch brief. It autoplays and loops. No visible replay, pause or reduced-motion controls were added.
- Plugins is pinned above the account row with Notion, Linear and GitHub marks. The right rail has Activity, Files and Memory, with no overflow menu, Conversations or Schedules.
- Rebuilt the setup dialog with six real characters, a clear Windows setup action, source-setup explanation and functional Explore action. Escape closes it and restores focus.
- Fixed mobile demo scaling, stacked narrow plugin-result rows, six-portrait wrapping, desktop sidebar/composer clipping and project-result clipping. Inspected 320, 390, 768 and 1200 CSS-pixel viewports. No horizontal overflow or broken loaded images found.
- Exercised mobile navigation, agent selection and automatic advancement, orange prompt selection and restoration of a custom draft, and opening/closing the plugin briefing. Checked active progress and completed-result placement above the composer. No browser errors were recorded.
- Production build and Sites packaging passed. All four hosting/packaging tests and `git diff --check` passed. A separate production-preview smoke check passed on port 4177.
- Evidence: `output/welcome-mobile-after.png`, `output/welcome-320.png`, `output/welcome-desktop-after.png`, `output/agents-mobile-after.png`, `output/workspace-desktop-after.png`, `output/agents-tablet-after.png`, `output/projects-desktop-after.png`, and `output/projects-tablet-after.png`. Animation screenshots show naturally occurring frames, not a common frozen timeline.
- Browser viewport emulation was used; no physical-phone or native-app acceptance is claimed. These marketing sequences are illustrative examples, not live agent executions.
- Deployed to the existing `mivlet-marketing` project in `joshuaknotts-projects`, production deployment `dpl_AbDMSummvmBfaA8QFsBwAWfqjuh9`. The Vercel connector reports READY. Public URL: `https://mivlet-marketing.vercel.app/`.
- Anonymous HTTP checks returned 200 with exact SHA-256 matches to the tested build for the HTML, all seven JS/CSS chunks, the favicon and six-character sprite. Only generated static output was uploaded; environment and authentication files were excluded. Existing deployment protection settings were left unchanged.
- Live browser verification confirmed the short title/favicon, redesigned mobile dialog, responsive project layout, automatic queued-to-complete progression and visible shared launch brief. No horizontal overflow at 390px or browser errors. Screenshots: `output/live-welcome-mobile.png`, `output/live-projects-mobile.png`, and `output/live-projects-desktop.png`.

## Historical verification

Date: 2026-10-18

final result: passed

## Current visual evidence

- Local production build: http://127.0.0.1:4176/.
- Original selected source: `C:/Users/Joshua Knott/.codex/generated_images/01a1500c-dee1-7453-afbc-ebec03ed3104/exec-0a441c02-deec-4d78-b83b-2560191d5fcf.png`.
- Revision source: `output/agent-navigation-direction.png`, generated with Imagegen using the selected layout and actual agent artwork.
- Combined source/implementation comparison: `output/revision-comparison.png`. Opened and inspected with both images visible together. Actual navigation, orange composer section and FAQ introduction are cropped from the final desktop capture and scaled to a comparable width.
- Full desktop page: `output/revision-desktop-full.png`, 1265 x 3374 pixels, captured at a 1280 x 900 CSS viewport with the vertical scrollbar accounting for 15 pixels.
- Responsive evidence: `output/revision-mobile-demo.png` (390px viewport), `output/revision-mobile-320.png`, and `output/revision-tablet.png` (768px viewport).
- Nova is selected. All reveals have entered; dialogs and FAQ answers are closed in the desktop capture. Animated scenes and the provider strip are captured at their current frames, not frozen to a common timestamp.

## User feedback implemented

- Composer structure grounded in current desktop `Composer.tsx`; exact model label `GPT-6.1 Sol High`.
- Projects above Agents and a Plugins row, grounded in `AgentSidebar.tsx`.
- Activity, Files and Memory rail with Conversations and Schedules under More, grounded in `WorkspaceRightNav.tsx`.
- Substantial Nova/Sage/Kit tabs replace minimal use-case pills. Mouse, touch, Arrow Left/Right, Home and End work, with one tab stop and a labelled panel.
- Twelve icon-only providers in a continuous horizontal loop, no links/buttons or provider dialog. Accessible name ChatGPT; corrected blue/purple Gemini mark. Duplicated loop hidden from assistive technology.
- Removed preview labels, glimpse caption, separate example-result link, filler eyebrow, Create badge, sparkle and shield decorations, and repeated orange-card controls.
- Actual agent portraits appear in the navigation, orange section and FAQ introduction.
- Existing yellow/blue product snippets, warm background, pill header and lavender workspace remain.

## Findings fixed during this revision

1. The taller composer crowded the completed result card on mobile. Increased the mobile composition from 420 x 470 to 420 x 520; inspected the completed Plan scene with the file card clearly above the composer.
2. Tablet search text and Windows shortcut wrapped in the compact sidebar. Kept search on one line and omitted the shortcut in the tablet illustration.
3. Decorative Remotion controls appeared in keyboard navigation. Made the illustration inert and exposed one descriptive accessible image; the surrounding use-case navigation remains interactive.
4. The orange model label resembled an unwired picker. Removed its dropdown caret while retaining the label and composer arrangement.

No unresolved P0/P1/P2 visual findings remain. The generated refinement is a layout guide rather than an exact app screenshot: the composer follows the real app, portraits are smaller, and the finished page keeps more space around its sections.

## Verification

- Production build and Sites packaging passed after final source changes.
- Four hosting/packaging tests passed. Their behavior was unaffected by the subsequent CSS layout refinement.
- `git diff --check` passed.
- Browser checks at 320, 390, 768 and 1280 CSS pixels found no horizontal overflow.
- Visible images loaded; no browser errors. Remotion's upstream license reminder is the only console warning.
- Use-case click and keyboard selection update agent, prompt and scenes. Focus remains on the selected tab.
- Provider strip visibly advances; DOM inspection confirms twelve named marks and zero interactive provider targets.
- Custom prompt opens setup guidance without a fabricated AI response; Escape closes the dialog and restores focus.
- Result document, mobile menu, page anchors, FAQ expansion and privacy dialog exercised.
- No pause controls or reduced-motion variants, per explicit user direction. Internal offscreen/hidden playback suspension remains.

## Scope

Local browser acceptance only. Animated app scenes are illustrations, not live AI/provider sessions. No installation, deployment, provider authentication or production acceptance is claimed. The desktop application and unrelated working tree changes were not modified.

## Automatic agent cycle verification

- The main Remotion player now advances on its `ended` event, cycling Nova, Sage and Kit in the same order as the visible tabs. Each scene runs for 14 seconds, including a completed-result hold.
- Production browser verification observed automatic agent, selected-tab, prompt and result changes. Sage produced `Workspace research.md`; Kit produced `First draft.md`.
- Manual Sage selection restarted immediately, then advanced automatically to Kit. Manually restarting Kit retained it through 12.6 seconds with its result visible; later automatic cycles continued.
- Typed custom composer content remained unchanged across automatic transitions. The initial manual-tab/composer coupling was subsequently replaced by the independent typing composer described below.
- Automatic selection did not move keyboard focus. Existing offscreen/hidden suspension remains, and opening a dialog holds the current scene to avoid changing a document while it is being read.
- Build, four hosting tests, independent code review and `git diff --check` passed. No layout or styling changed. Screenshot: `output/agent-cycle.png`.

## Transition and tab progress refinement

- Agent changes now crossfade for 15 frames (500 ms) from a frozen outgoing scene to the incoming scene, using the existing Remotion timeline. The outgoing layer is removed after the fade.
- The active tab has a 2px inset progress track. Its fill reads `--demo-progress`, written directly from the player's `frameupdate` event; it does not trigger page-wide React renders or run a separate timer.
- Browser evidence captured a manual Nova-to-Sage transition with both layers present, incoming opacity 0.049 and progress reset to 0.0048. A later observation confirmed the outgoing layer was removed and automatic cycling continued to Kit.
- Keyboard changes reset progress to zero and retain focus on the selected tab. Offscreen progress stayed exactly 0.011933 across observations, then resumed when the scene returned to view.
- Mobile inspection at 390px confirmed a 2px line, visible fill at 87 percent, no horizontal overflow and unchanged tab layout. Evidence: `output/agent-progress-mobile.png` and `output/agent-progress-desktop.png`.
- Production build, four hosting tests, independent code review and final whitespace checks passed. No pause controls or reduced-motion modes added.

## Orange composer typing cycle

- The orange composer now types, holds for 2.8 seconds, erases and cycles the Nova, Sage and Kit example prompts independently of the main demo. A subtle blinking caret follows the text.
- Animation is local to the composer component. Focus, a nonempty draft, offscreen visibility, hidden tabs and open dialogs suspend its timer. No pause controls or reduced-motion modes were added.
- Suggestions are visually overlaid on an empty editable textarea. A stable accessible description exposes the full example without announcing individual characters. Custom input is never part of the animation state.
- Browser verification observed all three examples and partial text. Sending while only `Turn t` was visible selected Nova's complete plan demo; sending a completed Kit example selected Kit. Custom text remained intact after blur and submitted to the existing setup guidance, then clearing the field resumed suggestions.
- Desktop form height remained 143px across changing examples. At 390px, the text wraps cleanly with matching 13px input/animation typography. At 320px, document width was 305px with no horizontal overflow.
- Production build and Sites packaging, four hosting tests, independent code review and `git diff --check` passed. Browser console contained no errors.
- Evidence: `output/orange-typing-desktop.png` and `output/orange-typing-mobile.png`. Local acceptance only; no deployment or live AI requests.

## Matching agent motion in the orange composer

- The orange section now shares its example and typing state directly with its portraits. The matching portrait lifts 5px, scales to 1.055 and gives a gentle 1.8-second nod while the prompt types. The other two remain still with softer emphasis.
- Highlighting stays with the readable example, then settles during the gap. Portrait motion uses the existing visibility/editing/dialog suspension state, without a separate synchronization timer.
- Browser inspection confirmed matching Nova and Sage prompts/portraits, only the active portrait receiving the greeting animation, and no animation on other portrait groups. Custom input removed all active/typing attributes and remained intact after blur; clearing it resumed the examples.
- Inspected desktop and 390px mobile layouts; 320px document width remained 305px without horizontal overflow. Evidence: `output/orange-agents-desktop.png` and `output/orange-agents-mobile.png`.
- Production build and packaging, four hosting tests, independent review and whitespace checks passed. Local browser acceptance only.

## Manual orange-card agent selection

- Orange portraits are now labelled native buttons in an example-prompt group, with pressed state, hover feedback and a visible keyboard focus ring. Decorative portrait groups elsewhere remain non-interactive.
- Choosing an agent restarts its typing and greeting, including repeat selection of the same agent. The existing automatic cycle continues from the selected example and does not move keyboard focus.
- Explicitly choosing an example temporarily hides an existing custom draft. Focusing the textarea restores that draft. Submission uses the displayed example, not the hidden draft.
- Browser checks exercised Sage click selection, Kit keyboard activation, automatic continuation while focus stayed on Kit, and a Nova replay resetting `Turn ` to an empty typing frame. A saved custom draft was restored exactly after selecting and submitting Sage's example.
- At 390px the three buttons each retain a 65 x 65px touch target, with no horizontal overflow. Main demo tabs and static portrait groups remain independent.
- Production build/packaging, four hosting tests, independent review and final whitespace checks passed. Evidence: `output/orange-agent-selection-desktop.png` and `output/orange-agent-selection-mobile.png`.

## Plugins section and connected-app example

- Imagegen source: output/plugins-direction.png (1488 x 1058); exact built-in Imagegen prompt: output/plugins-imagegen-prompt.txt. The generated image includes both the app introduction and the prompt/source/result scene.
- Implemented as React/CSS with real app marks and Nova artwork. Grounded connector names and the Notion/Linear workflow against the desktop catalog and guides. The marketing demo uses illustrative local data, not authenticated app requests.
- Compared source and browser captures together. Preserved ivory/mint palette, eight-card grid, two-column hierarchy, composer anatomy, source cards and briefing rows. Typography follows the existing site's scale; source arrival replaces the mock's static connector lines. Official current Drive and Canva marks intentionally differ from generated approximations.
- First comparison found an undersized Figma mark; cropped only its SVG viewport to the official mark bounds. Mobile inspection found missing heading whitespace and a truncated model label; fixed both and gave the toolbar a second row. Tablet header was tightened so all four links remain on one line.
- Browser checks at 1440, 1200, 768, 390 and 320px: assets loaded, no horizontal overflow; 320px document width was 305px. Full prompt fits its fixed-height box and GPT-6.1 Sol High remains visible. Final desktop evidence: output/plugins-desktop.png; mobile evidence: output/plugins-mobile.png.
- Observed typing, source reveal, completed briefing and repeated automatic cycles. Replay returns to typing. Read the briefing opens the example dialog; Escape closes and restores focus. Hidden result action is disabled and out of tab order. Focused reading action holds the scene; offscreen/document/dialog suspension reviewed independently.
- Production build and Sites packaging passed; four hosting tests passed; independent code review and git diff --check passed. Browser console had no errors. No deployment or live plugin execution performed.

Final result: passed
