import assert from "node:assert/strict";
import test from "node:test";
import { compareGraphs } from "./compare-graphs.mjs";

function fixture() {
  const chunk = (name, ids, imports = [], isEntry = false) => ({
    fileName: `assets/${name}-hash.js`,
    isEntry,
    imports: imports.map((n) => `assets/${n}-hash.js`),
    modules: ids.map((id) => ({ id, renderedLength: 10 })),
  });
  return {
    commit: "baseline",
    lockfileSha256: "same-lock",
    node: "v24",
    zlib: "same-zlib",
    platform: "win32",
    chunks: [
      chunk("index", ["src/main.ts"], ["vendor", "icons", "helpers"], true),
      chunk(
        "ExecutionWorker",
        ["src/worker.ts"],
        ["vendor", "icons", "helpers"],
      ),
      chunk(
        "FirstAgentOnboardingPage",
        ["src/onboarding.ts"],
        ["vendor", "icons", "helpers"],
      ),
      chunk("vendor", ["node_modules/react/index.js"]),
      chunk("icons", ["node_modules/icons/index.js"]),
      chunk("helpers", ["commonjsHelpers.js"]),
      chunk("workspace-tools", ["src/optional.ts"]),
      chunk("ConversationPane", ["src/conversation.ts"]),
    ],
  };
}

test("accepts same-module co-compression and only the new deferred custody helper", () => {
  const before = fixture(),
    after = structuredClone(before);
  after.commit = "final";
  const vendor = after.chunks[3];
  vendor.modules.push(...after.chunks[4].modules, ...after.chunks[5].modules);
  after.chunks = after.chunks.filter(
    (c) => !/\/(icons|helpers)-/.test(c.fileName),
  );
  for (const c of after.chunks)
    c.imports = c.imports.filter((n) => !/\/(icons|helpers)-/.test(n));
  after.chunks
    .find((c) => c.fileName.includes("workspace-tools"))
    .modules.push({
      id: "apps/desktop/src/components/hosted/hosted-task-custody.ts",
      renderedLength: 20,
    });
  const result = compareGraphs(before, after);
  assert.deepEqual(result.violations, []);
  assert.equal(result.closures[0].afterChunkCount, 2);
  assert.equal(result.addedModules.length, 1);
});

test("rejects budget-category migration even when module closure stays the same", () => {
  const before = fixture(),
    after = structuredClone(before);
  after.chunks[7].modules.push(after.chunks[6].modules.pop());
  const result = compareGraphs(before, after);
  assert.equal(result.categoryMoves.length, 1);
  assert.match(result.violations.join(), /budget category/);
});

test("rejects added startup dependency and an eager optional UI edge", () => {
  const before = fixture(),
    after = structuredClone(before);
  after.chunks[1].imports.push(after.chunks[6].fileName);
  const result = compareGraphs(before, after);
  assert.equal(result.closures[1].reachesWorkspaceTools, true);
  assert.deepEqual(result.closures[1].added, ["src/optional.ts"]);
  assert.ok(result.violations.length);
});

test("rejects disappeared and unexpected modules", () => {
  const before = fixture(),
    after = structuredClone(before);
  after.chunks[6].modules = [{ id: "src/unreviewed.ts", renderedLength: 1 }];
  const result = compareGraphs(before, after);
  assert.deepEqual(result.removedModules, ["src/optional.ts"]);
  assert.equal(result.violations.length, 2);
});

test("rejects incompatible runtime/lock metadata", () => {
  const before = fixture(),
    after = structuredClone(before);
  after.lockfileSha256 = "different";
  assert.match(
    compareGraphs(before, after).violations.join(),
    /lockfileSha256/,
  );
});

test("refuses lossy junction identities, duplicates and unresolved imports", () => {
  for (const mutate of [
    (r) => {
      r.chunks[3].modules[0].id = "[external]/index.js";
    },
    (r) => {
      r.chunks[3].modules.push(r.chunks[0].modules[0]);
    },
    (r) => {
      r.chunks[0].imports.push("assets/missing.js");
    },
    (r) => {
      r.chunks[0].isEntry = false;
    },
  ]) {
    const after = fixture();
    mutate(after);
    assert.throws(() => compareGraphs(fixture(), after));
  }
});
