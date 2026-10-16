import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Library, PromptOptions } from "@openuidev/react-lang";
import { buildRichInterfaceInstructions } from "../src/lib/rich-interface-prompt";
const server = await createServer({
  // This renderer-only code generator must not overwrite a running app's
  // dependency optimizer metadata and cause Outdated Optimize Dep responses.
  cacheDir: fileURLToPath(
    new URL("../../../output/ui-prompt-cache", import.meta.url),
  ),
  configFile: false,
  server: { middlewareMode: true },
  ssr: { noExternal: ["@openuidev/react-ui"] },
});
try {
  const { richInterfaceLibrary, richPromptOptions } =
    (await server.ssrLoadModule(
      "/src/components/conversation/generated/rich-catalogue.tsx",
    )) as { richInterfaceLibrary: Library; richPromptOptions: PromptOptions };
  const path = new URL(
    "../src/lib/rich-interface-instructions.json",
    import.meta.url,
  );
  const instructions = buildRichInterfaceInstructions(richInterfaceLibrary.prompt(richPromptOptions));
  const source = `${JSON.stringify({ instructions }, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== source)
      throw new Error("OpenUI instructions are stale. Run ui:generate.");
  } else await writeFile(path, source);
} finally {
  await server.close();
}
