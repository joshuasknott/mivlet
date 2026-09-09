# Fable artwork

The Fable mark and computer resting wallpaper were created with the built-in Image Gen tool for this project. Connector brand attribution is in [connectors/README.md](connectors/README.md).

Agent portraits use eight bundled robot shells created with Image Gen. The [asset notes](agents/README.md) record their origin and stable variant order. The app selects a shell locally with [blob-avatar.ts](../lib/blob-avatar.ts) and overlays expressions. No image-provider connection is required.

Creation prefers variants not already used in the workspace; the editor offers all eight shells. Renaming, rerendering, or restarting does not change the persisted selection. Uploaded images retain their original colours and take precedence until explicitly removed or replaced with a character.

Motion follows actual run state and is disabled for reduced motion. Uploaded portraits remain still. Regression tests cover allocation, stable seeds, uploaded-image ownership, and execution-state presentation.

The account, provider, and optional connector onboarding screens use the same mark and workspace palette, shared React controls, and native connection boundaries.
