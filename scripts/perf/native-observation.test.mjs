import assert from "node:assert/strict";
import test from "node:test";
import { selectProcessTree, summarizeSamples } from "./native-observation.mjs";

const process = (pid, parentPid, createdAt, bytes = 10) => ({ pid, parentPid, createdAt,
  name: "msedgewebview2", workingSetBytes: bytes, privateBytes: bytes / 2 });

test("tracks Mivlet descendants regardless of inventory order and excludes other WebViews", () => {
  const root = process(10, 1, "01");
  const child = process(11, 10, "02");
  const grandchild = process(12, 11, "03");
  assert.deepEqual(new Set(selectProcessTree([grandchild, process(20, 1, "02"), child, root], root)
    .map((item) => item.pid)), new Set([10, 11, 12]));
});

test("retains previously observed orphan children but excludes reused PIDs", () => {
  const root = process(10, 1, "01");
  const known = new Set();
  selectProcessTree([root, process(11, 10, "02"), process(12, 11, "03")], root, known);
  const remaining = selectProcessTree([root, process(11, 1, "04"), process(12, 11, "03"),
    process(13, 11, "05")], root, known);
  assert.deepEqual(remaining.map((item) => item.pid), [10, 12]);
});

test("a process older than its apparent parent is not a descendant after PID reuse", () => {
  const root = process(10, 1, "05");
  assert.deepEqual(selectProcessTree([process(20, 10, "02"), root], root), [root]);
  assert.deepEqual(selectProcessTree([process(10, 1, "06")], root), []);
});

test("computes simultaneous peaks and settled medians, not sums of individual peaks", () => {
  const result = summarizeSamples([
    { elapsedMs: 1, processes: [process(1, 0, "01", 100), process(2, 1, "02", 10)] },
    { elapsedMs: 30, processes: [process(1, 0, "01", 20), process(2, 1, "02", 50)] },
    { elapsedMs: 60, processes: [process(1, 0, "01", 10), process(2, 1, "02", 80)] },
  ]);
  assert.equal(result.peakWorkingSetBytes, 110);
  assert.equal(result.peakPrivateBytes, 55);
  assert.equal(result.settledMedianWorkingSetBytes, 80);
  assert.equal(result.settledMedianPrivateBytes, 40);
  assert.equal(result.observedThroughMs, 60);
});

test("refuses an empty measurement instead of reporting zero memory", () => {
  assert.throws(() => summarizeSamples([]), /No native process samples/);
});
