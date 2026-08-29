import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectAssets, logicalChunkId, summarizeBundle } from "./assets.mjs";
import { checkBudget, loadBudget } from "./budget-check.mjs";

/**
 * Tests for deterministic performance budgets.
 * All tests drive the real exported functions (no re-impls).
 * mkdtemp only for fs-dependent collect cases; other tests are pure.
 * Covers per AC/verification:
 * - missing builds (nonexistent dist)
 * - malformed config (bad JSON)
 * - path separators (win \ vs / normalization)
 * - threshold boundaries (exact == ceiling passes; +1 fails)
 * - unexpected assets (extra unlisted or future chunks do not cause violations)
 * Tests are repeatable, independent of machine speed (no wall-time or memory assertions here).
 */

test("logicalChunkId ignores hashed suffixes and handles real hyphenated Vite names", () => {
  // Basic
  assert.equal(logicalChunkId("index-D_VmwkJJ.js"), "index");
  assert.equal(logicalChunkId("SettingsPage-BV4Zsugu.js"), "SettingsPage");
  assert.equal(logicalChunkId("index-tCTFrDkm.css"), "index");
  assert.equal(logicalChunkId("inter-latin-400-normal.woff2"), undefined);
  // Hyphenated vendor (from manualChunks) and tricky hash-with-dash cases seen in builds
  assert.equal(logicalChunkId("react-vendor-DTgtZFgi.js"), "react-vendor");
  assert.equal(logicalChunkId("SettingsPage-BD-qQMfd.js"), "SettingsPage"); // hash portion contains '-'
  assert.equal(logicalChunkId("ApprovalPanel-BTtwof1a.js"), "ApprovalPanel");
  assert.equal(logicalChunkId("vendor-BSD_XLgc.js"), "vendor");
  assert.equal(
    logicalChunkId("WarningCircle.es-yeqg3xr8.js"),
    "WarningCircle.es",
  );
});

test("summarizeBundle groups totals and route chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "fable-perf-"));
  const distDir = join(root, "dist", "assets");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "index-abc123.js"), "a".repeat(100));
  await writeFile(join(distDir, "SettingsPage-def456.js"), "b".repeat(40));
  await writeFile(join(distDir, "index-abc123.css"), "c".repeat(20));

  const assets = await collectAssets(join(root, "dist"), root);
  const summary = summarizeBundle(assets);

  assert.equal(summary.totalJsCss.rawBytes, 160);
  assert.equal(summary.css.rawBytes, 20);
  assert.equal(summary.initialEntryJs.rawBytes, 100);
  assert.equal(summary.routeChunks.SettingsPage.rawBytes, 40);
});

test("checkBudget passes within ceilings", async () => {
  const budget = await loadBudget();
  const summary = {
    totalJsCss: {
      rawBytes: budget.observedBuild.totalJsCss.rawBytes,
      gzipBytes: budget.observedBuild.totalJsCss.gzipBytes,
    },
    css: { rawBytes: budget.observedBuild.css.rawBytes },
    initialEntryJs: { rawBytes: budget.observedBuild.initialEntryJs.rawBytes },
    routeChunks: Object.fromEntries(
      Object.entries(budget.observedBuild.routeChunks).map(
        ([chunkId, value]) => [chunkId, { rawBytes: value.rawBytes }],
      ),
    ),
  };

  assert.deepEqual(checkBudget(summary, budget), []);
});

test("checkBudget fails on material regression", async () => {
  const budget = await loadBudget();
  const summary = {
    totalJsCss: {
      rawBytes: budget.ceilings.totalJsCss.rawBytes + 1024,
      gzipBytes: budget.ceilings.totalJsCss.gzipBytes + 1024,
    },
    css: { rawBytes: budget.ceilings.css.rawBytes + 1024 },
    initialEntryJs: {
      rawBytes: budget.ceilings.initialEntryJs.rawBytes + 1024,
    },
    routeChunks: {
      SettingsPage: {
        rawBytes: budget.ceilings.routeChunks.SettingsPage.rawBytes + 1024,
      },
    },
  };

  const violations = checkBudget(summary, budget);
  assert.ok(
    violations.some((violation) => violation.label === "totalJsCss.raw"),
  );
  assert.ok(
    violations.some(
      (violation) => violation.label === "routeChunks.SettingsPage.raw",
    ),
  );
});
test("collectAssets throws on missing build (nonexistent dist dir)", async () => {
  const root = await mkdtemp(join(tmpdir(), "fable-perf-"));
  const missingDist = join(root, "nonexistent-dist");
  await assert.rejects(
    async () => collectAssets(missingDist, root),
    /ENOENT|no such file or directory|cannot find the path/i,
  );
});

test("loadBudget throws on malformed configuration (invalid JSON)", async () => {
  const root = await mkdtemp(join(tmpdir(), "fable-perf-"));
  const badBudgetPath = join(root, "bad-budget.json");
  await writeFile(
    badBudgetPath,
    '{ "ceilings": { "totalJsCss": { "rawBytes": 1 } } ',
  ); // truncated/invalid
  await assert.rejects(
    async () => loadBudget(badBudgetPath),
    /Unexpected end of JSON input|JSON|parse/i,
  );
});

test("collectAssets normalizes paths to POSIX separators on Windows and mixed inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "fable-perf-"));
  const distDir = join(root, "dist", "assets");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "index-xyz.js"), "x".repeat(10));
  await writeFile(join(distDir, "TestPage-abc.js"), "y".repeat(20));

  const assets = await collectAssets(join(root, "dist"), root);
  // All paths must use / even if FS used \
  for (const a of assets) {
    assert.ok(
      !a.path.includes("\\"),
      `path should not contain backslash: ${a.path}`,
    );
    assert.ok(
      a.path.includes("/"),
      `path should contain forward slash: ${a.path}`,
    );
  }
  // fileName extraction tolerates either
  assert.ok(assets.some((a) => a.fileName === "TestPage-abc.js"));
});

test("checkBudget passes on exact ceiling match (threshold boundary) for all metrics", async () => {
  const budget = await loadBudget();
  const c = budget.ceilings;
  const summary = {
    totalJsCss: {
      rawBytes: c.totalJsCss.rawBytes,
      gzipBytes: c.totalJsCss.gzipBytes,
    },
    css: { rawBytes: c.css.rawBytes },
    initialEntryJs: { rawBytes: c.initialEntryJs.rawBytes },
    routeChunks: Object.fromEntries(
      Object.entries(c.routeChunks).map(([chunkId, value]) => [
        chunkId,
        { rawBytes: value.rawBytes },
      ]),
    ),
  };
  assert.deepEqual(checkBudget(summary, budget), []);
});

test("checkBudget fails when any metric exceeds its ceiling by exactly 1 byte", async () => {
  const budget = await loadBudget();
  const c = budget.ceilings;
  const baseRoute = Object.fromEntries(
    Object.entries(c.routeChunks).map(([chunkId, value]) => [
      chunkId,
      { rawBytes: value.rawBytes },
    ]),
  );
  // Test +1 on total raw (others within)
  const overTotal = {
    totalJsCss: {
      rawBytes: c.totalJsCss.rawBytes + 1,
      gzipBytes: c.totalJsCss.gzipBytes,
    },
    css: { rawBytes: c.css.rawBytes },
    initialEntryJs: { rawBytes: c.initialEntryJs.rawBytes },
    routeChunks: baseRoute,
  };
  const v1 = checkBudget(overTotal, budget);
  assert.ok(
    v1.some((v) => v.label === "totalJsCss.raw"),
    "total +1 must violate",
  );

  // Test +1 on a route chunk only
  const overRoute = {
    totalJsCss: {
      rawBytes: c.totalJsCss.rawBytes,
      gzipBytes: c.totalJsCss.gzipBytes,
    },
    css: { rawBytes: c.css.rawBytes },
    initialEntryJs: { rawBytes: c.initialEntryJs.rawBytes },
    routeChunks: {
      ...baseRoute,
      SettingsPage: { rawBytes: c.routeChunks.SettingsPage.rawBytes + 1 },
    },
  };
  const v2 = checkBudget(overRoute, budget);
  assert.ok(
    v2.some((v) => v.label === "routeChunks.SettingsPage.raw"),
    "route +1 must violate",
  );
});

test("checkBudget reports violation for missing budgeted route chunk", async () => {
  const budget = await loadBudget();
  const summary = {
    totalJsCss: {
      rawBytes: budget.observedBuild.totalJsCss.rawBytes,
      gzipBytes: budget.observedBuild.totalJsCss.gzipBytes,
    },
    css: { rawBytes: budget.observedBuild.css.rawBytes },
    initialEntryJs: { rawBytes: budget.observedBuild.initialEntryJs.rawBytes },
    routeChunks: {}, // all missing
  };
  const violations = checkBudget(summary, budget);
  assert.ok(
    violations.some((v) =>
      v.message.includes("expected lazy route chunk missing"),
    ),
  );
});

test("checkBudget ignores unexpected extra assets when all budgeted items are within limits", async () => {
  const budget = await loadBudget();
  const summary = {
    totalJsCss: {
      rawBytes: budget.observedBuild.totalJsCss.rawBytes,
      gzipBytes: budget.observedBuild.totalJsCss.gzipBytes,
    },
    css: { rawBytes: budget.observedBuild.css.rawBytes },
    initialEntryJs: { rawBytes: budget.observedBuild.initialEntryJs.rawBytes },
    routeChunks: {
      ...Object.fromEntries(
        Object.entries(budget.observedBuild.routeChunks).map(
          ([chunkId, value]) => [chunkId, { rawBytes: value.rawBytes }],
        ),
      ),
      RetiredPage: { rawBytes: 669 },
      SomeFuturePage: { rawBytes: 1234 },
    },
  };
  const violations = checkBudget(summary, budget);
  assert.deepEqual(violations, []);
  // no violation should mention the extra chunks
  assert.ok(
    !violations.some((v) => /RetiredPage|SomeFuturePage/.test(v.message || "")),
  );
});

test("summarizeBundle filters react-vendor/vendor/index and collects hyphenated route chunks (real names)", () => {
  // Synthetic assets using real names observed in dist (including hyphen-in-hash)
  const assets = [
    {
      fileName: "index-BfHRN6kf.js",
      path: "apps/desktop/dist/assets/index-BfHRN6kf.js",
      type: "js",
      bytes: 100,
      gzipBytes: 30,
    },
    {
      fileName: "react-vendor-DTgtZFgi.js",
      path: "apps/desktop/dist/assets/react-vendor-DTgtZFgi.js",
      type: "js",
      bytes: 200,
      gzipBytes: 60,
    },
    {
      fileName: "SettingsPage-BD-qQMfd.js",
      path: "apps/desktop/dist/assets/SettingsPage-BD-qQMfd.js",
      type: "js",
      bytes: 50,
      gzipBytes: 15,
    },
    {
      fileName: "RetiredPage-D4kAx-IW.js",
      path: "apps/desktop/dist/assets/RetiredPage-D4kAx-IW.js",
      type: "js",
      bytes: 10,
      gzipBytes: 5,
    },
    {
      fileName: "vendor-BSD_XLgc.js",
      path: ".../vendor-BSD_XLgc.js",
      type: "js",
      bytes: 20,
      gzipBytes: 7,
    },
    {
      fileName: "index-abc.css",
      path: ".../index-abc.css",
      type: "css",
      bytes: 30,
      gzipBytes: 10,
    },
  ];
  const summary = summarizeBundle(assets);
  assert.equal(summary.initialEntryJs && summary.initialEntryJs.rawBytes, 100);
  assert.ok(
    !("react-vendor" in summary.routeChunks),
    "react-vendor must be filtered",
  );
  assert.ok(!("vendor" in summary.routeChunks), "vendor must be filtered");
  assert.ok(!("index" in summary.routeChunks), "index must be filtered");
  assert.equal(summary.routeChunks.SettingsPage.rawBytes, 50);
  assert.equal(summary.routeChunks.RetiredPage.rawBytes, 10);
});
