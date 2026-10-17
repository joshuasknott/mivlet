import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedTaskSha256, hostedTextContentFailure, readHostedTaskCapability, signHostedTaskCapability } from "@mivlet/protocol";
import { TaskAuthority } from "./task-authority";
import { ProviderCustody } from "./provider-custody";
import { ProviderFailure, runRealText } from "./provider";
import { admission } from "./contracts";
import { capabilityFixture, MemoryTaskStorage, taskFixture } from "./testing/fixtures";
import type { TaskEnv } from "./environment";

const secret = "unit-credential-never-valid-at-a-provider";
const environment = (extra: object = {}) => ({ MIVLET_HOSTED_TASK_SIGNING_KEY: "unit-signing-material-at-least-thirty-two", MIVLET_HOSTED_TASK_ENCRYPTION_KEY: "unit-encryption-material-is-separate-and-long", ...extra }) as TaskEnv;
const sse = (...payloads: unknown[]) => new Response(payloads.map(p => `data: ${JSON.stringify(p)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("hosted text admission", () => {
  it("rejects changed binding/input, tool-shaped context and local paths before admission", async () => {
    const value = taskFixture(); const cap = capabilityFixture();
    value.binding.inputSha256 = await hostedTaskSha256(value.input); cap.requestSha256 = await hostedTaskSha256(value);
    await expect(admission(value, cap)).resolves.toEqual(value);
    await expect(admission({ ...value, input: { messages: [{ role: "tool", content: "private" }] } }, cap)).rejects.toThrow("hosted-text-only");
    await expect(admission({ ...value, binding: { ...value.binding, workGeneration: 3 } }, cap)).rejects.toThrow("task-input-mismatch");
    expect(hostedTextContentFailure("Read C:\\Users\\unit\\document.txt")).toBe("hosted-local-path-content");
    expect(hostedTextContentFailure("Read /home/unit/document.txt")).toBe("hosted-local-path-content");
  });
  it("separates task capabilities from computer Bearer and rejects changed scope or expiry", async () => {
    const cap = capabilityFixture(); const key = "test-task-domain-signing-material-at-least32";
    const token = await signHostedTaskCapability(key, cap);
    await expect(readHostedTaskCapability(key, token)).resolves.toEqual(cap);
    await expect(readHostedTaskCapability(key, token.replace("mt1.", "v1."))).rejects.toThrow();
    await expect(readHostedTaskCapability(key, token, cap.expiresAt)).rejects.toThrow("task-capability-expired");
    const pieces = token.split("."); pieces[1] = btoa(JSON.stringify({ ...cap, scope: "credential:enroll" })).replace(/=/g, "");
    await expect(readHostedTaskCapability(key, pieces.join("."))).rejects.toThrow();
  });
});

describe("single real provider request", () => {
  it("uses the existing shaper with no tools and a fixed provider endpoint", async () => {
    const send = vi.fn(async () => sse({ choices: [{ delta: { content: "A real fixture answer." }, finish_reason: "stop" }] })); vi.stubGlobal("fetch", send);
    const value = taskFixture();
    await expect(runRealText(value.binding, value.input, secret, new AbortController().signal)).resolves.toEqual({ text: "A real fixture answer." });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, request] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions"); expect(request.redirect).toBe("error");
    const body = JSON.parse(String(request.body)); expect(body.messages).toEqual(value.input.messages); expect(body.tools).toBeUndefined(); expect(body.max_tokens).toBe(100);
  });
  it("never retries an interrupted possible send or accepts a truncated SSE answer", async () => {
    const send = vi.fn(async () => { throw new TypeError("network interrupted"); }); vi.stubGlobal("fetch", send);
    const value = taskFixture();
    await expect(runRealText(value.binding, value.input, secret, new AbortController().signal)).rejects.toMatchObject({ uncertain: true }); expect(send).toHaveBeenCalledTimes(1);
    send.mockImplementation(async () => sse({ choices: [{ delta: { content: "Incomplete" } }] }));
    await expect(runRealText(value.binding, value.input, secret, new AbortController().signal)).rejects.toBeInstanceOf(ProviderFailure); expect(send).toHaveBeenCalledTimes(2);
  });
  it("keeps known provider rejection distinct and prevents a split secret echo", async () => {
    const send = vi.fn(async () => new Response("not forwarded", { status: 401 })); vi.stubGlobal("fetch", send); const value = taskFixture();
    await expect(runRealText(value.binding, value.input, secret, new AbortController().signal)).rejects.toMatchObject({ code: "hosted-provider-authentication-required", uncertain: false });
    send.mockImplementation(async () => sse({ choices: [{ delta: { content: secret.slice(0, 12) } }] }, { choices: [{ delta: { content: secret.slice(12) }, finish_reason: "stop" }] }));
    await expect(runRealText(value.binding, value.input, secret, new AbortController().signal)).rejects.toMatchObject({ uncertain: true });
  });
});

describe("durable cloud custody", () => {
  it("stores ciphertext, consumes one-use nonces, and fences key revisions", async () => {
    const storage = new MemoryTaskStorage(); const custody = new ProviderCustody(storage.context(), environment()); const cap = capabilityFixture();
    await custody.consume(cap); await expect(custody.consume(cap)).rejects.toThrow("task-capability-replayed");
    const metadata = { credentialId: "credential-unit", providerId: "openai" as const, revision: 1 };
    const connection = await custody.enroll(cap, metadata, secret); expect(connection.enabled).toBe(true);
    expect(JSON.stringify(Array.from(storage.values))).not.toContain(secret);
    await expect(custody.enroll(cap, metadata, secret)).rejects.toThrow("credential-revision-mismatch");
    cap.resourceId = metadata.credentialId; await custody.revoke(cap, 1);
    await expect(custody.reserve(cap, taskFixture().binding, "digest-unit")).rejects.toThrow("hosted-provider-connection-required");
  });
  it("deduplicates admission reservations and bounds active account work", async () => {
    const custody = new ProviderCustody(new MemoryTaskStorage().context(), environment()); const cap = capabilityFixture();
    await custody.enroll(cap, { credentialId: "credential-unit", providerId: "openai", revision: 1 }, secret);
    const one = taskFixture().binding; await custody.reserve(cap, one, "one"); await custody.reserve(cap, one, "one");
    await expect(custody.reserve(cap, one, "changed")).rejects.toThrow("task-admission-conflict");
    await custody.reserve(cap, { ...one, taskId: "task-two", admissionId: "admit-two" }, "two");
    await expect(custody.reserve(cap, { ...one, taskId: "task-three", admissionId: "admit-three" }, "three")).rejects.toThrow("hosted-task-quota");
    await custody.release(cap.accountId, one.taskId, "one");
    await custody.reserve(cap, { ...one, taskId: "task-three", admissionId: "admit-three" }, "three");
  });
});

describe("generation-fenced cloud task", () => {
  it("cancels durably before an in-flight late result can commit", async () => {
    let finish!: (value: unknown) => void;
    const run = vi.fn(() => new Promise(resolve => { finish = resolve; })); const release = vi.fn(async () => undefined);
    const storage = new MemoryTaskStorage(); const task = new TaskAuthority(storage.context(), environment({ PROVIDER_CUSTODY: { getByName: () => ({ run, release }) } }));
    const cap = capabilityFixture(); const value = taskFixture(); await task.admit(cap, value);
    const running = task.alarm(); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const stopped = await task.cancel(cap, 1); expect(stopped.generation).toBe(2); expect(stopped.status).toBe("cancelled");
    finish({ ok: true, result: { text: "Late answer" } }); await running;
    expect(await task.read(cap)).toMatchObject({ snapshot: { generation: 2, status: "cancelled" }, text: "" });
  });
  it("never replays recovered running work and denies another account", async () => {
    const storage = new MemoryTaskStorage(); const run = vi.fn(); const task = new TaskAuthority(storage.context(), environment({ PROVIDER_CUSTODY: { getByName: () => ({ run }) } })); const cap = capabilityFixture();
    await task.admit(cap, taskFixture()); const row = await storage.get<{ snapshot: { status: string } }>("task"); row!.snapshot.status = "running"; await storage.put("task", row);
    await task.alarm(); expect(run).not.toHaveBeenCalled();
    expect(await task.read(cap)).toMatchObject({ snapshot: { status: "uncertain", generation: 2 }, text: "" });
    await expect(task.read({ ...cap, accountId: "another-account" })).rejects.toThrow("task-scope-mismatch");
  });
  it("removes task text and input after the disclosed retention", async () => {
    vi.useFakeTimers(); const now = Date.now(); const storage = new MemoryTaskStorage(); const task = new TaskAuthority(storage.context(), environment({ PROVIDER_CUSTODY: { getByName: () => ({ release: async () => undefined }) } })); const cap = capabilityFixture(now);
    await task.admit(cap, taskFixture(now)); vi.setSystemTime(now + 86_400_001); await task.alarm();
    expect(await task.read(cap)).toMatchObject({ snapshot: { status: "expired" }, text: "" });
    expect(JSON.stringify(Array.from(storage.values))).not.toContain("Explain the seasons");
  });
});
