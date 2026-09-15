# Provider brand assets

Assets in this directory identify third-party providers in the provider and
model-picker surfaces. Marks remain the property of their respective owners;
their use is nominative identification only and does not imply endorsement.
They are bundled locally; no remote image requests happen at runtime.

| Asset | Source | Terms |
| --- | --- | --- |
| `cursor.svg` | [Cursor favicon](https://cursor.com/marketing-static/favicon.svg), retrieved 2026-09-11 | Official site artwork; Cursor trademark, owned by Anysphere. Use follows [Cursor brand guidance](https://cursor.com/brand) for identification only. |
| `opencode.svg` | [OpenCode favicon](https://opencode.ai/favicon.svg), retrieved 2026-09-11 | Official site artwork; OpenCode trademark, owned by SST. Identification only. |
| `google-antigravity.png` | Google's official Antigravity icon | Google trademark; identification only. |

The OpenAI symbol in `provider-artwork.svg`, referenced by `ProviderIcon.tsx`, is OpenAI's current
official symbol (2025 refresh), reproduced verbatim from
[OpenAI logo 2025 (symbol).svg](https://commons.wikimedia.org/wiki/File:OpenAI_logo_2025_(symbol).svg)
(public domain, no attribution required). It is presented monochrome through
`--provider-monochrome` (black on light themes, near-white on dark), per
OpenAI's guidance against recolouring or redrawing the mark.

`provider-artwork.svg` and `connector-artwork.svg` retain the existing vector
geometry from the provider and connector components. Local SVG references keep
that artwork out of JavaScript while preserving size, colour and identification.

The generated Phosphor sprite retains the package's MIT artwork. Its complete
license is bundled as `phosphor-LICENSE.txt`.

The brand marks in `additional-provider-artwork.svg` are from [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/a94750e3f5f8fc33757b839d85030e742284e43a/packages/static-svg/icons), pinned to commit `a94750e3f5f8fc33757b839d85030e742284e43a`. Original path geometry, colour fills, gradients and fill rules are retained in local SVG symbols. Gradient identifiers are prefixed per provider to prevent collisions. The MIT license is included in `lobe-icons-LICENSE.txt`; provider trademarks remain with their owners. Alibaba uses Qwen artwork, Moonshot uses the Kimi product artwork, and SiliconFlow uses SiliconCloud artwork. Colour variants are used wherever available. Groq uses its primary #F55036 from the same pinned source (`src/Groq/style.ts`). Z.ai retains its monochrome mark; uncoloured portions of artwork inherit the theme's provider monochrome colour.

The Claude symbol (`provider-artwork.svg#anthropic`) is the original orange symbol path from the [official Claude site](https://claude.com/), retrieved 2026-09-14. Its 125 by 125 geometry and #D97757 fill are preserved. The internal Anthropic provider identifier is retained; the company AI monogram is no longer used for Claude. Anthropic trademark, identification only.

Kimi retains its blue accent (#1783FF); its letter uses the theme-aware provider monochrome colour instead of a fixed white fill, so the mark stays legible on light and dark surfaces.
