import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const base = "http://127.0.0.1:8797/task";
const evidenceFile = new URL("task-evidence.local.json", import.meta.url);
const expected = "alpha=2\nbeta=3\ngamma=5\ntotal=10\n";
const expectedHash = createHash("sha256").update(expected).digest("hex");
async function request(id, action, body) {
  return fetch(`${base}/${id}/${action}`, { method: action === "status" ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
}
async function state(id) { return (await request(id, "status")).json(); }
async function waiting(id) {
  for (let i = 0; i < 80; i++) {
    const current = await state(id);
    if (current.status === "approval") return current;
    assert.ok(["scheduled", "running"].includes(current.status), `task gate failed: ${JSON.stringify(current)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail(`Scheduled fixture did not reach its approval checkpoint: ${JSON.stringify(await state(id))}`);
}
async function approve(id, approval) {
  const response = await request(id, "approve", approval);
  assert.equal(response.status, 200);
  const current = await response.json();
  assert.equal(current.status, "completed");
  assert.equal(current.artifact, expected);
  assert.equal(current.receipt.artifactHash, expectedHash);
  assert.equal(current.receipt.bytes, Buffer.byteLength(expected));
  assert.equal(current.approval, undefined);
  return current;
}

if (process.argv.includes("--after-restart")) {
  const previous = JSON.parse(await readFile(evidenceFile, "utf8"));
  const pending = await state(previous.waitingId);
  assert.equal(pending.status, "approval");
  assert.deepEqual(pending.approval, previous.approval);
  const probe = await (await fetch(`http://127.0.0.1:8797/probe-status?name=task-${pending.attempt}`, { signal: AbortSignal.timeout(20_000) })).json();
  assert.equal(probe.sdkSessionPersisted, true);
  assert.equal(probe.modelCalls, 0);
  assert.equal(probe.toolCalls, 0);
  assert.deepEqual((await state(previous.completedId)).receipt, previous.receipt);
  await approve(previous.waitingId, pending.approval);
  assert.equal((await request(previous.waitingId, "approve", pending.approval)).status, 409);
  console.log("PASS: pending approval and completed receipt survive workerd restart; exact resume commits once.");
} else {
  const id = `fixture-${randomUUID()}`;
  assert.equal((await fetch(`${base}/${id}/start`, { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
  assert.equal((await request(id, "start", { prompt: "arbitrary user input" })).status, 400);
  await request(id, "start");
  const pending = await waiting(id);
  const replayStart = await (await request(id, "start")).json();
  assert.equal(replayStart.attempt, pending.attempt);
  for (const changed of [
    { ...pending.approval, generation: pending.generation + 1 },
    { ...pending.approval, owner: { ...pending.approval.owner, workspace: "other-workspace" } },
    { ...pending.approval, owner: { ...pending.approval.owner, agent: "other-agent" } },
    { ...pending.approval, artifactHash: "wrong-hash" },
  ]) assert.equal((await request(id, "approve", changed)).status, 409);
  assert.equal((await state(id)).artifact, undefined);
  const completed = await approve(id, pending.approval);
  assert.equal((await request(id, "approve", pending.approval)).status, 409);
  assert.deepEqual((await state(id)).receipt, completed.receipt);

  const cancelledId = `cancel-${randomUUID()}`;
  await request(cancelledId, "start");
  const cancelled = await (await request(cancelledId, "cancel")).json();
  assert.equal(cancelled.status, "cancelled");
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal((await state(cancelledId)).artifact, undefined);
  assert.equal((await request(cancelledId, "approve", pending.approval)).status, 409);
  assert.equal((await state(cancelledId)).generation, cancelled.generation);

  const waitingId = `restart-${randomUUID()}`;
  await request(waitingId, "start");
  const checkpoint = await waiting(waitingId);
  await writeFile(evidenceFile, JSON.stringify({ waitingId, approval: checkpoint.approval, completedId: id, receipt: completed.receipt }, null, 2));
  console.log("PASS: scheduled SDK model/tool fixture, exact approval, artifact bytes/hash, replay and cross-scope rejection, cancelled callback fence.");
  console.log("Restart workerd, then run check-task.mjs --after-restart to verify durable approval and receipt recovery.");
}
