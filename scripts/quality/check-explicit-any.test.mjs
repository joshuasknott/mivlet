import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(
  new URL("./check-explicit-any.mjs", import.meta.url),
);

function runScanner(directory) {
  return execFileSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env },
  });
}

test("ignores generated output while counting production source", () => {
  const directory = mkdtempSync(join(tmpdir(), "mivlet-explicit-any-"));
  try {
    const source = join(directory, "apps", "desktop", "src");
    const output = join(directory, "apps", "desktop", "output", "history-qa");
    const wrangler = join(directory, "packages", "worker", ".wrangler");
    mkdirSync(source, { recursive: true });
    mkdirSync(output, { recursive: true });
    mkdirSync(wrangler, { recursive: true });

    const productionSource = (count) =>
      Array.from(
        { length: count },
        (_, index) => `export const value${index} = undefined as any;`,
      ).join("\n");
    writeFileSync(join(source, "production.ts"), productionSource(127));
    writeFileSync(
      join(output, "preview.tsx"),
      "const preview = undefined as any;\n",
    );
    writeFileSync(
      join(wrangler, "worker.ts"),
      "const worker = undefined as any;\n",
    );

    assert.match(runScanner(directory), /127\/127 occurrences/);

    writeFileSync(join(source, "production.ts"), productionSource(128));
    assert.throws(
      () => runScanner(directory),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr, /count 128 exceeds the ratchet 127/);
        return true;
      },
    );
  } finally {
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith("mivlet-explicit-any-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
