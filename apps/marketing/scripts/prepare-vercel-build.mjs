import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const app = new URL("../", import.meta.url);
const output = new URL(".vercel/output/", app);
await mkdir(output, { recursive: true });
await cp(new URL("dist/client/", app), new URL("static/", output), {
  recursive: true,
});
await writeFile(
  new URL("config.json", output),
  JSON.stringify({ version: 3 }, null, 2) + "\n",
);
console.log(`Prepared Vercel static output: ${fileURLToPath(output)}`);
