import type { Plugin } from "vite";

const namespaces = ["thread", "message", "composer", "actionBar"] as const;

/** The pinned package wraps its ESM barrels in generated getter objects.
 * Native namespace imports preserve live bindings while allowing Rollup to
 * remove unused primitives (parts rendering, dictation, viewport and menus).
 * Application imports and the package's implementations stay unchanged. */
export function treeShakeAssistantEntry(code: string): string {
  for (const name of namespaces) {
    const original = `import { ${name}_exports } from "./primitives/${name}.js";`;
    if (code.split(original).length !== 2)
      throw new Error(
        `The assistant-ui ${name} entry changed; review its namespace optimization.`,
      );
    code = code.replace(
      original,
      `import * as ${name}_exports from "./primitives/${name}.js";`,
    );
  }
  return code;
}

export function treeShakeAssistantPrimitives(): Plugin {
  return {
    name: "mivlet-assistant-primitives",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      if (!/[/\\]@assistant-ui[/\\]react[/\\]dist[/\\]index\.js$/.test(id))
        return null;
      return { code: treeShakeAssistantEntry(code), map: null };
    },
  };
}
