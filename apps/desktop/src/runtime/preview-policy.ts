// Preview fixtures are a build-time development/test facility, never a
// runtime flag that can enable synthetic storage in a production renderer.
export const ALLOW_PREVIEW_FALLBACKS =
  import.meta.env.DEV || import.meta.env.MODE === "test";
