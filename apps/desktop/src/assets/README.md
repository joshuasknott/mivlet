# Fable artwork

The Fable mark and computer resting wallpaper were created with the built-in Image Gen tool for this project. Connector brand attribution is in [connectors/README.md](connectors/README.md).

Agent portraits follow an original soft blob direction explored with Image Gen: irregular mineral-coloured silhouettes, small round eyes, and a quiet smile. The app generates the artwork locally with [blob-avatar.ts](../lib/blob-avatar.ts), rather than selecting from a fixed image set or requiring an image-provider connection.

Every new teammate receives a versioned random `avatarSeed`, saved with the profile through browser and native persistence. Existing profiles receive a deterministic seed from their stable ID. Names, instructions, model changes, rerenders, and restart do not change the portrait. An uploaded image takes precedence; removing it reveals that teammate's original generated portrait.

Keep the `blob-v1` renderer stable. Future design versions must preserve rendering of existing seeds. The regression fixture checks v1 stability; generation tests cover 1,000 distinct portraits. This is a generative system with a large variation space, not a promise of mathematically unlimited distinct pixels.

The reference-generation prompt is recorded in [avatar-direction.json](avatar-direction.json). The 12 examples in the generated reference are a style study, not production presets.
