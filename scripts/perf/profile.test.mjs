import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { bundleProfile } from "./profile.mjs";

test("profile measures written assets, retains budget failures, and omits source", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "mivlet-bundle-profile-"));
  const dist = join(repoRoot, "dist");
  await mkdir(join(dist, ".vite"), { recursive: true });
  const js = 'console.log("production bytes");';
  const worker = "export const worker = true;";
  const css = ".example{color:red}";
  await writeFile(join(dist, "index-abc.js"), js);
  await writeFile(join(dist, "pdf.worker.min-abc.mjs"), worker);
  await writeFile(join(dist, "index-abc.css"), css);
  await writeFile(join(dist, ".vite/manifest.json"), "{}");
  await writeFile(join(repoRoot, "pnpm-lock.yaml"), "fixture-lock");
  const bundle = {
    "index-abc.js": {
      type: "chunk",
      fileName: "index-abc.js",
      isEntry: true,
      isDynamicEntry: false,
      code: "SOURCE_CANARY_NOT_AN_ARTIFACT",
      imports: ["vendor-abc.js"],
      dynamicImports: ["Review-abc.js"],
      modules: {
        [`${repoRoot}\\src\\review.tsx`]: { renderedLength: 123 },
        [`\0${repoRoot}/src/helper.ts?commonjs-proxy`]: { renderedLength: 3 },
        "C:/unrelated-host-path/module.js": { renderedLength: 1 },
      },
    },
  };
  const before = structuredClone(bundle);
  const plugin = bundleProfile({ repoRoot, commit: "fixture-commit" });
  plugin.configResolved({ root: repoRoot, build: { outDir: "dist" } });
  await plugin.writeBundle.handler({}, bundle);
  assert.deepEqual(bundle, before);
  const raw = await readFile(
    join(repoRoot, "output/bundle-profile/report.json"),
    "utf8",
  );
  const report = JSON.parse(raw);
  assert.equal(report.commit, "fixture-commit");
  assert.equal(
    report.lockfileSha256,
    createHash("sha256").update("fixture-lock").digest("hex"),
  );
  assert.equal(
    report.summary.commonJsCss.rawBytes,
    Buffer.byteLength(js + css),
  );
  assert.equal(
    report.summary.commonJsCss.gzipBytes,
    gzipSync(js).length + gzipSync(css).length,
  );
  assert.equal(report.summary.pdfPreview.rawBytes, Buffer.byteLength(worker));
  assert.ok(report.violations.some((v) => v.label === "deferred.entry"));
  assert.deepEqual(report.chunks[0].imports, ["vendor-abc.js"]);
  assert.deepEqual(report.chunks[0].dynamicImports, ["Review-abc.js"]);
  assert.deepEqual(report.chunks[0].modules, [
    { id: "src/review.tsx", renderedLength: 123 },
    { id: "src/helper.ts?commonjs-proxy", renderedLength: 3 },
    { id: "[external]/module.js", renderedLength: 1 },
  ]);
  assert.ok(!raw.includes("SOURCE_CANARY"));
  assert.ok(!raw.includes("unrelated-host-path"));
});

test("profile fails when the actual build output is missing", async () => {
  const repoRoot = await mkdtemp(
    join(tmpdir(), "mivlet-bundle-profile-missing-"),
  );
  const plugin = bundleProfile({ repoRoot, commit: "fixture-commit" });
  plugin.configResolved({ root: repoRoot, build: { outDir: "missing" } });
  await assert.rejects(plugin.writeBundle.handler({}, {}), { code: "ENOENT" });
  await assert.rejects(
    readFile(join(repoRoot, "output/bundle-profile/report.json")),
    { code: "ENOENT" },
  );
});
