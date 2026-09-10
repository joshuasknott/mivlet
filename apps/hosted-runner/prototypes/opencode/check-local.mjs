import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const base = "http://127.0.0.1:8797";
const request = (path, init) => fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(45_000) });
const status = await (await request("/status")).json();

if (process.argv.includes("--after-restart")) {
  const before = JSON.parse(await readFile(new URL("evidence.local.json", import.meta.url), "utf8"));
  assert.ok(status.boots > before.boots, "new Durable Object instance must boot");
  assert.equal(status.persistedSessionId, before.sessionId, "session identity must survive the local runtime restart");
  assert.equal(status.sdkSessionPersisted, true, "the SDK must read the persisted session from its database");
  assert.equal(status.modelCalls, 0, "recovery must not run the synthetic model without a new request");
  assert.equal(status.toolCalls, 0, "recovery must not execute the artifact tool");
  console.log("PASS: durable identity survived a local process restart; no automatic continuation proven.");
  process.exit(0);
}

assert.equal((await request("/run", { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
assert.equal((await request("/run", { method: "POST", body: "real conversation" })).status, 400);
assert.equal((await request("/unknown")).status, 404);
const response = await request("/run", { method: "POST" });
const result = await response.json();
assert.equal(typeof result.sessionId, "string");
assert.ok(result.pluginSetups >= 1, "plugin setup must actually execute");
const duplicate = await (await request("/run", { method: "POST" })).json();
assert.equal(duplicate.sessionId, result.sessionId, "repeated requests must not create a second session in this boot");
assert.equal(duplicate.toolCalls, result.toolCalls);
assert.equal((await request("/cancel", { method: "POST" })).status, 200);
await writeFile(new URL("evidence.local.json", import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log("PASS: no external context accepted, plugin setup, duplicate request fence, cancel endpoint.");
console.log(JSON.stringify(result, null, 2));
if (response.status !== 200 || result.modelCalls === 0 || result.toolCalls === 0) {
  console.error("BLOCKED: the SDK session did not reach the synthetic model and artifact tool. No successful agent-loop claim.");
  process.exitCode = 1;
} else {
  console.log("PASS: SDK loop reached the synthetic model and paused tool. Artifact approval and write remain unimplemented.");
}
