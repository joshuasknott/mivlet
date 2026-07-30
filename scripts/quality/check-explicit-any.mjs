import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["apps", "packages"];
const excludedDirectories = new Set([
  ".astro",
  "_generated",
  "dist",
  "node_modules",
  "target",
]);
const sourcePattern = /\.(?:ts|tsx)$/u;
const excludedFilePattern = /\.(?:test|spec)\.(?:ts|tsx)$/u;
const explicitAnyPattern =
  /(?:\bas\s+any\b|:\s*any\b|<\s*any\s*>|\bany\s*\[\s*\])/gu;
const maximum = 238;

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(absolute)));
    } else if (
      sourcePattern.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !excludedFilePattern.test(entry.name)
    ) {
      files.push(absolute);
    }
  }
  return files;
}

const files = (await Promise.all(roots.map(collect))).flat();
let count = 0;
for (const file of files) {
  const source = await readFile(file, "utf8");
  count += [...source.matchAll(explicitAnyPattern)].length;
}

if (count > maximum) {
  console.error(
    `Production explicit-any count ${count} exceeds the ratchet ${maximum}. Validate the boundary or tighten the type instead.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Production explicit-any ratchet passed: ${count}/${maximum} occurrences.`,
  );
}
