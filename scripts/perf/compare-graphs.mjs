import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  conversationUpgradeAssetPattern,
  intelligentUiAssetPattern,
} from "./assets.mjs";

const custodyModule =
  "apps/desktop/src/components/hosted/hosted-task-custody.ts";

function category(fileName) {
  const name = fileName.split("/").at(-1);
  if (conversationUpgradeAssetPattern.test(name)) return "conversationUpgrade";
  if (intelligentUiAssetPattern.test(name)) return "intelligentUi";
  if (/^(PdfPreview-|pdf-renderer-|pdf\.worker\.min-)/.test(name))
    return "pdfPreview";
  return "commonJsCss";
}

function index(report) {
  assert.ok(Array.isArray(report.chunks), "Profile must contain chunks");
  const chunks = new Map(),
    modules = new Map();
  for (const chunk of report.chunks) {
    assert.equal(typeof chunk.fileName, "string");
    assert.ok(
      !chunks.has(chunk.fileName),
      `Duplicate chunk: ${chunk.fileName}`,
    );
    assert.ok(Array.isArray(chunk.imports) && Array.isArray(chunk.modules));
    chunks.set(chunk.fileName, chunk);
    for (const module of chunk.modules) {
      assert.equal(typeof module.id, "string");
      assert.ok(
        !module.id.startsWith("[external]/"),
        `Lossy module identity requires a clean-checkout profile: ${module.id}`,
      );
      assert.ok(
        !modules.has(module.id),
        `Duplicate module identity: ${module.id}`,
      );
      modules.set(module.id, {
        category: category(chunk.fileName),
        chunk: chunk.fileName,
      });
    }
  }
  return { chunks, modules };
}

function staticClosure(graph, predicate) {
  const starts = [...graph.chunks.values()].filter(predicate);
  assert.equal(starts.length, 1, "Expected exactly one matching startup chunk");
  const chunks = new Set(),
    modules = new Set();
  function visit(name) {
    if (chunks.has(name)) return;
    const chunk = graph.chunks.get(name);
    assert.ok(chunk, `Unresolved static chunk import: ${name}`);
    chunks.add(name);
    for (const module of chunk.modules) modules.add(module.id);
    chunk.imports.forEach(visit);
  }
  visit(starts[0].fileName);
  return { chunks, modules };
}

const difference = (left, right) =>
  [...left].filter((id) => !right.has(id)).sort();

/** This compares identity/reachability; the unchanged budget gate measures bytes. */
export function compareGraphs(before, after) {
  const violations = [];
  for (const key of ["lockfileSha256", "node", "zlib", "platform"]) {
    assert.equal(typeof before[key], "string", `Missing baseline ${key}`);
    assert.equal(typeof after[key], "string", `Missing final ${key}`);
    if (before[key] !== after[key]) violations.push(`Profile ${key} differs`);
  }
  const a = index(before),
    b = index(after);
  const categoryMoves = [];
  for (const [id, owner] of a.modules) {
    const next = b.modules.get(id);
    if (next && next.category !== owner.category)
      categoryMoves.push({ id, before: owner, after: next });
  }
  if (categoryMoves.length)
    violations.push("Existing modules changed budget category");
  const addedModules = difference(
    new Set(b.modules.keys()),
    new Set(a.modules.keys()),
  );
  const removedModules = difference(
    new Set(a.modules.keys()),
    new Set(b.modules.keys()),
  );
  if (
    addedModules.some(
      (id) =>
        id !== custodyModule || b.modules.get(id).category !== "commonJsCss",
    )
  )
    violations.push("Unexpected new modules or custody accounting");
  if (removedModules.length) violations.push("Existing modules disappeared");
  const closures = [
    ["entry", (chunk) => chunk.isEntry],
    ["ExecutionWorker", (chunk) => /\/ExecutionWorker-/.test(chunk.fileName)],
    [
      "FirstAgentOnboardingPage",
      (chunk) => /\/FirstAgentOnboardingPage-/.test(chunk.fileName),
    ],
  ].map(([name, predicate]) => {
    const previous = staticClosure(a, predicate),
      current = staticClosure(b, predicate);
    const added = difference(current.modules, previous.modules);
    const removed = difference(previous.modules, current.modules);
    const reachesWorkspaceTools = [...current.chunks].some((file) =>
      /\/workspace-tools-/.test(file),
    );
    if (added.length || removed.length || reachesWorkspaceTools)
      violations.push(
        `${name} static module closure changed or eagerly loads workspace tools`,
      );
    return {
      name,
      beforeModuleCount: previous.modules.size,
      afterModuleCount: current.modules.size,
      beforeChunkCount: previous.chunks.size,
      afterChunkCount: current.chunks.size,
      added,
      removed,
      reachesWorkspaceTools,
    };
  });
  return {
    baselineCommit: before.commit,
    finalCommit: after.commit,
    categoryMoves,
    addedModules,
    removedModules,
    closures,
    violations,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [beforePath, afterPath, outputPath] = process.argv.slice(2);
  assert.ok(
    beforePath && afterPath,
    "Usage: node compare-graphs.mjs BASELINE FINAL [OUTPUT]",
  );
  const result = compareGraphs(
    JSON.parse(await readFile(beforePath, "utf8")),
    JSON.parse(await readFile(afterPath, "utf8")),
  );
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized);
  console.log(serialized);
  if (result.violations.length) process.exitCode = 1;
}
