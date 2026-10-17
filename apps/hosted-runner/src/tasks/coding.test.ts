import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedTaskSha256, hostedCodingTaskPolicy, validateHostedCodingScope, HOSTED_CODING_IMAGE, type HostedCodingTaskBinding, type HostedRepositorySnapshot } from "@mivlet/protocol";
import { admission } from "./contracts";
import { byteSha256, codingRepository, encodeCodingChunk, utf8 } from "./coding-contracts";
import { CodingFiles } from "./coding-custody";
import { codingJournal, codingState, type CodingState } from "./coding-journal";
import { runRealCoding } from "./coding-provider";
import type { CodingRuntimeBinding } from "./coding-runtime-contract";
import { TaskAuthority } from "./task-authority";
import type { TaskEnv } from "./environment";
import { capabilityFixture, MemoryTaskStorage, taskFixture } from "./testing/fixtures";

const key = "unit-provider-key-not-valid-at-any-provider";
const content = "export const value = 1;\n";
async function fixture() {
  const source = utf8.encode(content); const sha256 = await byteSha256(source); const path = utf8.encode("main.js");
  const tree = new Uint8Array(8 + path.length + 32); new DataView(tree.buffer).setBigUint64(0, BigInt(path.length), true); tree.set(path, 8); tree.set(Uint8Array.from(sha256.match(/../g)!, pair => parseInt(pair, 16)), 8 + path.length);
  const unsigned = { version: 1 as const, snapshotId: "a".repeat(48), repositoryId: "b".repeat(48), branch: "main", baseCommit: "c".repeat(40), inputTreeId: await byteSha256(tree), files: [{ path: "main.js", sizeBytes: source.length, sha256 }], writablePaths: ["main.js", "new.js"], totalBytes: source.length };
  const snapshot: HostedRepositorySnapshot = { ...unsigned, manifestSha256: await hostedTaskSha256(unsigned) };
  const scope = { writablePaths: [...snapshot.writablePaths], checks: [{ id: "syntax", argv: ["/usr/bin/node", "--check", "main.js"] as [string, ...string[]] }], image: HOSTED_CODING_IMAGE, network: "disabled" as const };
  const binding: HostedCodingTaskBinding = { ...taskFixture().binding, version: 3, mode: "offline-coding", model: "gpt-4.1", repository: { snapshot, scope }, budget: { maxModelCalls: 4, maxToolCalls: 8, maxOutputTokens: 4096, maxElapsedMs: 120000, maxResultBytes: 65536 } };
  const input = { messages: [{ role: "system" as const, content: hostedCodingTaskPolicy(binding.repository) }, { role: "user" as const, content: "Change the value to two and run the syntax check." }] };
  binding.inputSha256 = await hostedTaskSha256(input); return { binding, input, source };
}
async function custody(value: Awaited<ReturnType<typeof fixture>>) {
  const storage = new MemoryTaskStorage(); let active = true;
  const files = new CodingFiles(storage.context().storage, async () => { if (!active) throw new Error("stopped"); return value.binding; });
  await files.putInput({ taskId: value.binding.taskId, snapshotId: value.binding.repository.snapshot.snapshotId, path: "main.js", offset: 0, dataBase64: encodeCodingChunk(value.source) }); await files.sealInput();
  storage.values.set("journal", codingState(120000));
  const journal = codingJournal(value.binding, operation => storage.transaction(async tx => { if (!active) throw new Error("stopped"); const state = (await tx.get<CodingState>("journal"))!; const result = operation(state); await tx.put("journal", state); return result; }));
  return { files, storage, journal, stop: () => { active = false; }, access: { manifest: () => files.manifest(), bytes: (file: { path: string; sizeBytes: number; sha256: string }) => files.currentBytes(file), read: (path: string, offset: number, length: number) => files.read(path, offset, length), write: (path: string, expected: string | null, text: string | null) => files.write(path, expected, text), sealOutput: () => files.sealOutput() } };
}
const sse = (payload: unknown) => new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } });
const tool = (name: string, args: unknown, id: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });
function runtime(): CodingRuntimeBinding {
  let current: Parameters<CodingRuntimeBinding["begin"]>[0];
  return { prerequisites: vi.fn(async () => ({ image: HOSTED_CODING_IMAGE, network: "disabled", proof: "positive-and-negative-v1" })), begin: vi.fn(async value => { current = value; }), file: vi.fn(async () => {}), cancel: vi.fn(async () => {}), run: vi.fn(async (_lease, id) => ({ leaseId: current.leaseId, stepId: current.stepId, candidateSha256: current.candidateSha256, id, exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false })) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("reviewed isolated scratch admission", () => {
  it("binds every exported hash, writable path, argv and fixed network/image to exact policy", async () => {
    const value = await fixture(); const cap = capabilityFixture(); cap.requestSha256 = await hostedTaskSha256({ binding: value.binding, input: value.input });
    await expect(admission({ binding: value.binding, input: value.input }, cap)).resolves.toMatchObject({ binding: { version: 3 } });
    await expect(codingRepository({ ...value.binding.repository, snapshot: { ...value.binding.repository.snapshot, totalBytes: 1 } })).rejects.toThrow();
    await expect(codingRepository({ ...value.binding.repository, scope: { ...value.binding.repository.scope, writablePaths: ["other.js"] } })).rejects.toThrow();
    await expect(admission({ binding: value.binding, input: { messages: [value.input.messages[1]] } }, cap)).rejects.toThrow("coding-policy-review-required");
    for (const argv of [["/bin/sh", "-c", "anything"], ["node", "--check", "main.js"], ["/usr/bin/curl", "https://example.com"]]) expect(() => validateHostedCodingScope({ ...value.binding.repository.scope, checks: [{ id: "bad", argv }] })).toThrow();
    for (const path of ["../private", ".git/config", ".env", "C:\\private", "a/CON", "a/../b", "main.js/child"]) await expect(codingRepository({ ...value.binding.repository, scope: { ...value.binding.repository.scope, writablePaths: [path] } })).rejects.toThrow();
  });
  it("keeps input custody immutable and refuses wrong chunks, hashes, scope and Stop", async () => {
    const value = await fixture(); const { files, stop } = await custody(value);
    await expect(files.putInput({ taskId: value.binding.taskId, snapshotId: value.binding.repository.snapshot.snapshotId, path: "main.js", offset: 0, dataBase64: encodeCodingChunk(value.source) })).rejects.toThrow();
    await expect(files.write("private.js", null, "no")).rejects.toThrow();
    await expect(files.write("main.js", "0".repeat(64), "changed")).rejects.toThrow("coding-candidate-changed");
    stop(); await expect(files.write("main.js", value.binding.repository.snapshot.files[0].sha256, "changed")).rejects.toThrow("stopped");
  });
  it("retains only exact candidate modifications/deletions and seals a reproducible output digest", async () => {
    const value = await fixture(); const { files } = await custody(value);
    await files.write("main.js", value.binding.repository.snapshot.files[0].sha256, null); await files.write("new.js", null, "export const value = 2;\n");
    const manifest = await files.sealOutput(); const { outputManifestSha256, ...unsigned } = manifest;
    expect(outputManifestSha256).toBe(await hostedTaskSha256(unsigned)); expect(manifest.deletedPaths).toEqual(["main.js"]); expect(manifest.files.map(file => file.path)).toEqual(["new.js"]);
    await expect(files.outputChunk({ taskId: value.binding.taskId, path: "new.js", offset: 0, outputManifestSha256: "0".repeat(64) })).rejects.toThrow();
    expect((await files.outputChunk({ taskId: value.binding.taskId, path: "new.js", offset: 0, outputManifestSha256 })).end).toBe(true);
  });
  it("journals before effects, refuses unfinished-step replay and enforces cumulative tokens/tools", async () => {
    const value = await fixture(); const { journal } = await custody(value); const hash = "a".repeat(64);
    const id = await journal.start("model", hash, 1024); await expect(journal.start("model", hash, 1024)).rejects.toThrow();
    await journal.finish(id, hash); await expect(journal.finish(id, hash)).rejects.toThrow();
    for (let i = 1; i < 4; i++) { const id = await journal.start("model", hash, 1024); await journal.finish(id, hash); }
    await expect(journal.start("model", hash, 1)).rejects.toThrow(); expect((await journal.progress()).allocatedOutputTokens).toBe(4096);
  });
});

describe("real provider adapters over closed scratch tools", () => {
  it("writes approved candidate bytes, checks that exact tree, and returns an authenticated manifest", async () => {
    const value = await fixture(); const c = await custody(value); const service = runtime(); let calls = 0;
    const send = vi.fn(async (_url: string, request: RequestInit) => {
      expect((await c.journal.progress()).steps.at(-1)?.status).toBe("dispatching"); expect(request.redirect).toBe("manual");
      const body = JSON.parse(String(request.body)); expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(["scratch_read", "scratch_write", "scratch_check"]);
      return ++calls === 1 ? sse(tool("scratch_write", { path: "main.js", expectedSha256: value.binding.repository.snapshot.files[0].sha256, content: "export const value = 2;\n" }, "write_1"))
        : calls === 2 ? sse(tool("scratch_check", { id: "syntax" }, "check_1")) : sse({ choices: [{ delta: { content: "Changed the value and the syntax check passed." }, finish_reason: "stop" }] });
    }); vi.stubGlobal("fetch", send);
    const result = await runRealCoding(value.binding, value.input, key, new AbortController().signal, c.journal, c.access, service);
    expect(result.coding).toMatchObject({ modelCalls: 3, toolCalls: 2, allocatedOutputTokens: 3072, completedChecks: [{ id: "syntax", exitCode: 0 }] });
    expect(service.file).toHaveBeenCalledWith(expect.any(String), "main.js", "export const value = 2;\n"); expect(JSON.stringify(vi.mocked(service.file).mock.calls)).not.toContain(key);
    expect(result.coding!.output.files[0].sha256).toBe(await byteSha256(utf8.encode("export const value = 2;\n"))); expect(service.cancel).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(3);
  });
  it("durably parks an exact new-scope proposal while preserving the importable original candidate", async () => {
    const value = await fixture(); const c = await custody(value); const service = runtime();
    vi.stubGlobal("fetch", vi.fn(async () => sse(tool("scratch_write", { path: "extra.js", expectedSha256: null, content: "unapproved" }, "new_path"))));
    const result = await runRealCoding(value.binding, value.input, key, new AbortController().signal, c.journal, c.access, service);
    expect(result.coding?.proposal).toMatchObject({ tool: "scratch_write", reason: "path-outside-scope" }); expect(result.coding?.output.files).toEqual(value.binding.repository.snapshot.files); expect(service.begin).not.toHaveBeenCalled();
  });
  it("refuses missing runtime/unproven network and never retries uncertain or redirected provider egress", async () => {
    const value = await fixture(); let c = await custody(value); const send = vi.fn(async () => { throw new Error("possible send interrupted"); }); vi.stubGlobal("fetch", send);
    await expect(runRealCoding(value.binding, value.input, key, new AbortController().signal, c.journal, c.access, undefined)).rejects.toMatchObject({ uncertain: false }); expect(send).not.toHaveBeenCalled();
    const service = runtime(); vi.mocked(service.prerequisites).mockRejectedValueOnce(new Error("positive control unavailable"));
    await expect(runRealCoding(value.binding, value.input, key, new AbortController().signal, c.journal, c.access, service)).rejects.toMatchObject({ uncertain: false }); expect(send).not.toHaveBeenCalled();
    c = await custody(value); await expect(runRealCoding(value.binding, value.input, key, new AbortController().signal, c.journal, c.access, runtime())).rejects.toMatchObject({ uncertain: true }); expect(send).toHaveBeenCalledOnce();
    send.mockImplementation(async () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } })); c = await custody(value);
    await expect(runRealCoding(value.binding, value.input, key, new AbortController().signal, c.journal, c.access, runtime())).rejects.toMatchObject({ uncertain: true }); expect(send).toHaveBeenCalledTimes(2);
  });
  it("checks Stop after the runtime prerequisite before any model send", async () => {
    const value = await fixture(); const c = await custody(value); const service = runtime(); const controller = new AbortController(); const send = vi.fn(); vi.stubGlobal("fetch", send);
    vi.mocked(service.prerequisites).mockImplementationOnce(async () => { controller.abort(); return { image: HOSTED_CODING_IMAGE, network: "disabled", proof: "positive-and-negative-v1" }; });
    await expect(runRealCoding(value.binding, value.input, key, controller.signal, c.journal, c.access, service)).rejects.toMatchObject({ uncertain: false }); expect(send).not.toHaveBeenCalled();
  });
});

describe("immutable-manifest transfer leases", () => {
  it("binds nonce/device/expiry and rejects all transfer effects after durable Stop", async () => {
    const value = await fixture(); const storage = new MemoryTaskStorage(); const release = vi.fn(async () => {});
    const env = { PROVIDER_CUSTODY: { getByName: () => ({ release }) } } as unknown as TaskEnv;
    const authority = new TaskAuthority(storage.context(), env); const cap = capabilityFixture();
    await authority.admit(cap, { binding: value.binding, input: value.input });
    const upload = { ...cap, scope: "task:input" as const, requestSha256: await hostedTaskSha256({ taskId: value.binding.taskId, snapshotId: value.binding.repository.snapshot.snapshotId, manifestSha256: value.binding.repository.snapshot.manifestSha256 }) };
    expect(await authority.transfer(upload, false)).toBe(false); expect(await authority.transfer(upload, true)).toBe(true); expect(await authority.transfer(upload, false)).toBe(true);
    await expect(authority.transfer({ ...upload, deviceId: "other-device" }, true)).rejects.toThrow(); await expect(authority.transfer({ ...upload, requestSha256: "a".repeat(64) }, true)).rejects.toThrow();
    await expect(authority.transfer({ ...upload, expiresAt: Date.now() }, true)).rejects.toThrow();
    await authority.cancel(cap, 1);
    await expect(authority.inputChunk(upload, { taskId: value.binding.taskId, snapshotId: value.binding.repository.snapshot.snapshotId, path: "main.js", offset: 0, dataBase64: encodeCodingChunk(value.source) }, value.binding.repository.snapshot.manifestSha256)).rejects.toThrow();
    await expect(authority.sealInput(upload, value.binding.repository.snapshot.snapshotId, value.binding.repository.snapshot.manifestSha256)).rejects.toThrow();
  });
});
