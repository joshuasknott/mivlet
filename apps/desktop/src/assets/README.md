# Fable artwork

The Fable mark and computer resting wallpaper were created with the built-in Image Gen tool for this project. Connector brand attribution is in [connectors/README.md](connectors/README.md).

Agent portraits use four bundled Organic shapes explored with Image Gen. The app selects a shape locally with [blob-avatar.ts](../lib/blob-avatar.ts) and applies the agent's chosen colour. No image-provider connection is required.

Every new agent receives an `organic-v1` seed containing its selected shape and a random identifier, saved with the profile through browser and native persistence. Consecutive creations cycle through the four shapes. Legacy `blob-v1` seeds map deterministically to an Organic shape; their former generated artwork is not retained. Names, instructions, model changes, rerenders, and restart do not change the selected shape. An uploaded image takes precedence and keeps its original colours; removing it reveals the agent's selected Organic shape and colour.

Keep the `organic-v1` shape mapping stable across releases. Regression tests cover consecutive shape selection, saved identities, and deterministic legacy-seed mapping. Unique seeds do not guarantee visually unique portraits: shapes and colours can repeat.

The earlier blob-avatar style study is recorded in [avatar-direction.json](avatar-direction.json). Its 12 examples describe the superseded generative direction, not the current Organic shape library.

The account, provider, and optional connector onboarding screens use the same approved mark and workspace palette. Their Image Gen briefs are recorded in [onboarding-direction.json](onboarding-direction.json); the implemented screens use shared React controls and the native connection boundaries.
