# Fable artwork

The Fable mark and computer resting wallpaper were created with the built-in Image Gen tool for this project. Connector brand attribution is in [connectors/README.md](connectors/README.md).

Agent portraits use eight bundled rounded characters created with Image Gen, packaged as 256px transparent PNGs. The app selects a shape locally with [blob-avatar.ts](../lib/blob-avatar.ts), tints its light body, and preserves its dark eyes. No image-provider connection is required.

New profiles persist a `rounded-v2` seed. Creation prefers silhouettes not already used in the workspace; the editor also offers all eight shapes. Existing `organic-v1` indices map to the corresponding rounded member, while other legacy seeds resolve deterministically. Renaming, rerendering, or restarting does not change that selection. Uploaded images retain their original colours and take precedence until explicitly removed or replaced with a character.

Motion follows actual run state and is disabled for reduced motion. Uploaded portraits remain still. Regression tests cover allocation, stable seeds, uploaded-image ownership, and execution-state presentation.

The account, provider, and optional connector onboarding screens use the same approved mark and workspace palette. Their Image Gen briefs are recorded in [onboarding-direction.json](onboarding-direction.json); the implemented screens use shared React controls and the native connection boundaries.
