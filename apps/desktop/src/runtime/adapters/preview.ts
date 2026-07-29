import type { RuntimeAdapter } from "../ports";

/**
 * Preview fixtures are implemented by the relevant domain port. Reaching a
 * native command through this adapter is therefore a boundary error, never an
 * invitation to synthesize native authority.
 */
export const previewRuntimeAdapter: RuntimeAdapter = {
  kind: "preview",
  async invoke(command: string) {
    throw new Error(
      `Native command "${command}" is unavailable in Fable's development preview.`,
    );
  },
  async listen() {
    return () => undefined;
  },
};
