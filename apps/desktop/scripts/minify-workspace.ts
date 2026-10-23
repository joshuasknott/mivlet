import { minify } from "uglify-js";
import type { Plugin } from "vite";

/** Normalize the emitted ESM before the existing Terser pass. Keep public
 * names, property keys, legal notices and the original chunk graph intact. */
export function normalizeEmittedCode(): Plugin {
  return {
    name: "mivlet-normalize-emitted-code",
    apply: "build",
    renderChunk: {
      order: "pre",
      handler(code, _chunk, options) {
        if (options.format !== "es" || options.sourcemap) return null;
        const result = minify(code, {
          module: true,
          // Keeping single-use function bindings improves the renderer's
          // gzip size through the following minifier passes.
          compress: { passes: 3, reduce_funcs: false },
          mangle: true,
          output: { comments: "some" },
        });
        if (result.error) throw result.error;
        if (!result.code)
          throw new Error("The emitted module could not be minified.");
        return { code: result.code, map: null };
      },
    },
  };
}
