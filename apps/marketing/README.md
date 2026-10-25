# Mivlet marketing

A responsive marketing page based on the selected Mivlet design, with animated
Remotion product scenes, an animated line of twelve provider marks, agent-led
navigation, example documents, a prompt composer, and Windows setup information.

## Local development

From this directory, with Node 22+ and pnpm 10:

```powershell
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 4176 --strictPort
```

Open http://127.0.0.1:4176/.

This app has an independent pnpm workspace and lockfile, so installing it does
not change the desktop application's dependency graph.

```powershell
pnpm test
pnpm build
```

The production site is generated in `dist/client`. The included hosting adapter
and packaging script also prepare `dist/server` and `dist/.openai` for an eventual
Sites deployment. Nothing is deployed by the build command.

## Scope

The product scenes and example documents are illustrative. The marketing page
does not send prompts to an AI provider, collect credentials, or save input.
The primary CTA goes directly to the demo. Windows setup links go directly to
the repository's development instructions, with experimental source-release
status visible on the page. Provider support copy is grounded in Mivlet's connector catalogue;
it does not represent authenticated acceptance of each provider.

Animations run automatically, without pause controls or reduced-motion variants,
as requested. Remotion playback stops internally when a scene is offscreen or the
page is hidden, then continues when visible. The site remains keyboard navigable,
with native modal focus handling and labelled controls.
Silent Players start muted with no shared audio tags, so browser audio permission
does not stall the animation on a fresh visit. Responsive loading placeholders
reserve the finished scene's aspect ratio to prevent jumps while chunks load.

The main demo opens on Nova's completed launch plan. Clicking or keyboard-selecting
Nova, Sage, Kit, Otto, Fern or Pip plays that agent's scene once and holds the
finished result. Agents never switch automatically, and there are no pause or
replay controls. Manual changes use a 333 ms crossfade. Opening a dialog holds the
current scene; a completed scene stays completed when it closes. A readable
example document is available directly below the workspace.
Compact yellow/blue cards beneath the hero show the selected prompt and a real
excerpt from that same example document, which opens on click.

The orange composer types the selected example once and holds it.
Suggestions stop while editing a custom draft.
Sending a suggestion opens its complete matching demo even while
the text is being typed. Animation suspends offscreen, in hidden tabs and while a
dialog is open. Custom drafts remain intact when selecting agents elsewhere.
The matching agent portrait lifts with a small greeting motion as its example
types and stays highlighted while the example is readable.
Portrait motion uses the same typing state and suspension
rules; entering a custom prompt returns all six portraits to neutral.
Clicking or keyboard-activating an orange-card portrait restarts that agent's
example and greeting, then holds the result. A custom draft is retained
while browsing examples and restored when the composer is focused again.

The Plugins section introduces eight work-app connections separately from AI
providers. Its illustrative Nova example reads a Notion plan, checks Linear
issues, and produces a launch briefing in under four seconds. The sequence loops
automatically; Read the briefing opens a sample document. Playback suspends offscreen, in hidden tabs,
while a dialog is open, or while the result action has keyboard focus.
No accounts are connected and no real app data is fetched by this page.

The separate Projects demo shows six attributed contributions flowing into a
shared launch brief. Its 11-second Remotion loop starts with useful content and
builds the complete brief within six seconds. The scene measures its natural
layout to keep text readable across desktop, tablet and mobile widths.

The section is based on the built-in Imagegen mockup at
`output/plugins-direction.png`; its exact prompt is saved in
`output/plugins-imagegen-prompt.txt`. The mock includes both the app introduction
and the prompt-to-result example. Native app UI is implemented in HTML/CSS rather
than displaying the mockup as a flattened screenshot.

## Assets

- Mivlet brand and agent imagery: existing Mivlet desktop assets.
- Provider marks: existing provider sprites and their bundled license notices.
- OpenRouter: official Ink glyph for light backgrounds from
  https://openrouter.ai/brand and
  https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-ink.svg.
- Gemini: the blue/purple four-point mark from
  https://commons.wikimedia.org/wiki/File:Google-gemini-icon.svg
  (the source page identifies the vector as CC0).
- Hero ribbon and underline: individually generated raster assets, optimized with
  transparent backgrounds.
- Interface icons: Phosphor; font: Inter, locally bundled via Fontsource.
- Plugin marks: existing Mivlet connector assets plus official full-color Google
  and Figma brand assets. Sources and notices: `public/plugins/README.md`.
- Animation runtime: Remotion Player 4.0.534. Its upstream license terms apply.

See `design-qa.md` for browser evidence and verification details.

## Vercel production deployment

Project: `joshuaknotts-projects/mivlet-marketing`.
Production: https://mivlet-marketing.vercel.app

The initial release uploaded the verified static build using Vercel Build Output API v3. To prepare another static release after running `pnpm build` and the tests, run `node scripts/prepare-vercel-build.mjs`, then deploy from this app directory with `vercel deploy --prebuilt --prod --archive=tgz`. Confirm the local Vercel link points to this project before deploying. `.vercel` and environment files are ignored. No Git auto-deployment is configured.

Deployment `dpl_FaxNH7x316T72YxvLgfDcNyLNkir` is production READY. It contains the local marketing changes based on repository commit `6db7c141`; these changes are not committed or pushed. The production alias is publicly accessible; deployment protection settings were left intact. HTML, JS, CSS, Nova artwork and the Figma mark returned HTTP 200 and matched the tested local files byte-for-byte.
