import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedTaskSha256, publicWebTaskPolicy, publicWebUrl, validatePublicWebScope, type HostedPublicWebTaskBinding } from "@mivlet/protocol";
import { taskFixture, capabilityFixture, MemoryTaskStorage } from "./testing/fixtures";
import { admission } from "./contracts";
import { researchJournal, researchState, type ResearchState } from "./research-journal";
import { runRealResearch } from "./research-provider";
import { extractPublicPage, publicWebReader, type PublicPage } from "./public-web-reader";
import { ProviderCustody } from "./provider-custody";
import { TaskAuthority } from "./task-authority";
import type { TaskEnv } from "./environment";

const secret = "unit-key-not-valid-at-any-provider";
const scope = { allowedDomains: ["example.com"], initialUrls: ["https://example.com/"] };
function fixture() {
  const value = taskFixture();
  const binding: HostedPublicWebTaskBinding = { ...value.binding, model: "gpt-4.1", version: 2, mode: "public-web-research", webScope: structuredClone(scope),
    budget: { maxModelCalls: 4, maxOutputTokens: 4096, maxElapsedMs: 120000, maxResultBytes: 65536, maxPageReads: 6, maxSourceBytes: 65536 } };
  return { binding, input: { messages: [{ role: "system" as const, content: publicWebTaskPolicy(scope) }, { role: "user" as const, content: "Read the known page and summarize its public evidence." }] } };
}
function journalFixture(binding: HostedPublicWebTaskBinding, signal = new AbortController().signal) {
  const storage = new MemoryTaskStorage(); storage.values.set("journal", researchState("attempt-unit", 120000));
  return { storage, journal: researchJournal(binding, operation => storage.transaction(async tx => {
    const state = (await tx.get<ResearchState>("journal"))!; const result = operation(state); await tx.put("journal", state); return result;
  }), signal) };
}
async function page(): Promise<PublicPage> {
  const text = "A public source about seasons."; const contentSha256 = await hostedTaskSha256({ finalUri: scope.initialUrls[0], text });
  return { source: { citationId: `web-${contentSha256.slice(0,24)}`, title: "Seasons", finalUri: scope.initialUrls[0], fetchedAt: new Date().toISOString(), contentSha256, contentBytes: new TextEncoder().encode(text).length, truncated: false }, text, links: [] };
}
const sse = (value: unknown) => new Response(`data: ${JSON.stringify(value)}\n\n`, { headers: { "content-type": "text/event-stream" } });
const tool = (url = scope.initialUrls[0], name = "web-fetch") => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name, arguments: JSON.stringify({ url }) } }] }, finish_reason: "tool_calls" }] });
const answer = (text = "Supported answer.") => ({ choices: [{ delta: { content: text }, finish_reason: "stop" }] });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("separately reviewed public web authority", () => {
  it("keeps v1 one-call-only and requires v2 exact full policy/scope/hash", async () => {
    const value = fixture(); const cap = capabilityFixture(); value.binding.inputSha256 = await hostedTaskSha256(value.input); cap.requestSha256 = await hostedTaskSha256(value);
    await expect(admission(value, cap)).resolves.toEqual(value);
    await expect(admission({ ...value, input: { messages: value.input.messages.slice(1) } }, cap)).rejects.toThrow("research-policy-review-required");
    await expect(admission({ ...value, binding: { ...value.binding, webScope: { ...scope, allowedDomains: ["other.com"] } } }, cap)).rejects.toThrow();
    const text = taskFixture(); text.binding.budget.maxModelCalls = 2;
    await expect(admission(text, cap)).rejects.toThrow("invalid-task-budget");
  });
  it("refuses private/literal/credential/non-HTTPS/extra-domain/wildcard scope", () => {
    for (const domain of ["localhost", "10.0.0.1", "127.1", "*.example.com", "example.com.", "EXAMPLE.com", "[::1]", "example.internal"]) expect(() => validatePublicWebScope({ ...scope, allowedDomains: [domain] })).toThrow();
    for (const url of ["http://example.com/", "https://u:p@example.com/", "https://example.com:444/", "https://other.com/", "https://example.com/?access_token=private", "https://127.0.0.1/"]) expect(() => publicWebUrl(url, scope.allowedDomains)).toThrow();
  });
});

describe("bounded static public reader", () => {
  it("uses no credentials/cookies/auth, manual redirects, bounded plain text and source hash", async () => {
    const send = vi.fn(async () => new Response("Public evidence.", { headers: { "content-type": "text/plain; charset=utf-8", "set-cookie": "private=value" } })); vi.stubGlobal("fetch", send);
    const result = await publicWebReader.read(scope.initialUrls[0], scope, new AbortController().signal);
    expect(result.text).toBe("Public evidence."); expect(result.source.contentSha256).toBe(await hostedTaskSha256({ finalUri: scope.initialUrls[0], text: result.text }));
    const request = send.mock.calls[0] as unknown as [string, RequestInit]; expect(request[1]).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", cache: "no-store" });
    expect(JSON.stringify(request[1].headers)).not.toMatch(/authorization|cookie/i);
  });
  it("revalidates every redirect before egress and refuses active/oversized content", async () => {
    const send = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } })); vi.stubGlobal("fetch", send);
    await expect(publicWebReader.read(scope.initialUrls[0], scope, new AbortController().signal)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1);
    send.mockImplementation(async () => new Response("active", { headers: { "content-type": "application/javascript" } }));
    await expect(publicWebReader.read(scope.initialUrls[0], scope, new AbortController().signal)).rejects.toThrow("research-passive-text-required");
    send.mockImplementation(async () => new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/plain" } }));
    await expect(publicWebReader.read(scope.initialUrls[0], scope, new AbortController().signal)).rejects.toThrow("research-page-limit");
  });
  it.skipIf(typeof HTMLRewriter === "undefined")("removes hidden/form/script subtrees before text and link extraction in Workerd", async () => {
    const bytes = new TextEncoder().encode('<title>Public title</title><h1>Public heading</h1><p>Public evidence</p><form>PRIVATE_FORM<input value="PRIVATE_VALUE"></form><div hidden>PRIVATE_HIDDEN<a href="/hidden">hidden</a></div><script>PRIVATE_SCRIPT</script><a href="/next">Next</a>');
    const result = await extractPublicPage(bytes, "text/html", scope.initialUrls[0], scope, new AbortController().signal);
    expect(result.text).toContain("Public heading Public evidence"); expect(result.text).not.toContain("PRIVATE_"); expect(result.links).toEqual(["https://example.com/next"]);
    const long = await extractPublicPage(new TextEncoder().encode(`<p>Public evidence${" ".repeat(40000)}Omitted tail</p>`), "text/html", scope.initialUrls[0], scope, new AbortController().signal);
    expect(long.source.truncated).toBe(true); expect(long.text).not.toContain("Omitted tail");
  });
});

describe("real adapter loop over a closed read executor", () => {
  it("journals before each possible model/read effect and returns a cited source receipt", async () => {
    const value = fixture(); const { journal, storage } = journalFixture(value.binding); const source = await page(); let calls = 0;
    const send = vi.fn(async (_url: string, request: RequestInit) => {
      const state = (await storage.get<ResearchState>("journal"))!;
      expect(state.steps.at(-1)).toMatchObject({ kind: "model", status: "dispatching" });
      const body = JSON.parse(String(request.body)); expect(body.tools.map((item: { function: { name: string } }) => item.function.name)).toEqual(["web-fetch"]);
      expect(request.redirect).toBe("manual");
      expect(body.max_tokens).toBe(1024); expect(body.messages[0].content).toBe(value.input.messages[0].content);
      return ++calls === 1 ? sse(tool()) : sse(answer(`Seasons are described [${source.source.citationId}].`));
    }); vi.stubGlobal("fetch", send);
    const read = vi.fn(async () => { expect((await storage.get<ResearchState>("journal"))!).toMatchObject({ pageReads: 1 }); return source; });
    const result = await runRealResearch(value.binding, value.input, secret, new AbortController().signal, journal, { read });
    expect(result.research).toMatchObject({ modelCalls: 2, pageReads: 1, sources: [source.source] }); expect(read).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(2);
    const state = (await storage.get<ResearchState>("journal"))!; expect(state.steps.map(step => step.status)).toEqual(["completed", "completed", "completed"]); expect(state.allocatedTokens).toBe(2048);
  });
  it("does not retry uncertain provider egress or read through another tool/domain", async () => {
    const value = fixture(); const send = vi.fn(async () => { throw new Error("interrupted possible send"); }); vi.stubGlobal("fetch", send);
    await expect(runRealResearch(value.binding, value.input, secret, new AbortController().signal, journalFixture(value.binding).journal)).rejects.toMatchObject({ uncertain: true }); expect(send).toHaveBeenCalledOnce();
    let calls = 0; send.mockImplementation(async () => ++calls === 1 ? sse(tool("https://other.com/")) : sse(answer()));
    const read = vi.fn(); await expect(runRealResearch(value.binding, value.input, secret, new AbortController().signal, journalFixture(value.binding).journal, { read })).rejects.toMatchObject({ code: "research-incomplete" }); expect(read).not.toHaveBeenCalled();
  });
  it("refuses provider redirects without following them or sending a second request", async () => {
    const value = fixture(); const send = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://other.com/" } })); vi.stubGlobal("fetch", send);
    await expect(runRealResearch(value.binding, value.input, secret, new AbortController().signal, journalFixture(value.binding).journal)).rejects.toMatchObject({ code: "hosted-provider-request-rejected" });
    expect(send).toHaveBeenCalledOnce();
  });
  it("refuses an encoded cloud key in a model URL before the page reader", async () => {
    const value = fixture(); let calls = 0; vi.stubGlobal("fetch", async () => ++calls === 1 ? sse(tool(`https://example.com/?q=${secret.split("").map(c => `%${c.charCodeAt(0).toString(16)}`).join("")}`)) : sse(answer()));
    const read = vi.fn(); await expect(runRealResearch(value.binding, value.input, secret, new AbortController().signal, journalFixture(value.binding).journal, { read })).rejects.toMatchObject({ code: "research-incomplete" }); expect(read).not.toHaveBeenCalled();
  });
  it("persists step caps, refuses replayed completion and stops after cancellation", async () => {
    const value = fixture(); const controller = new AbortController(); const { journal, storage } = journalFixture(value.binding, controller.signal);
    const digest = "a".repeat(64); const one = await journal.model(digest, 1024); await journal.finish(one, digest);
    await expect(journal.finish(one, digest)).rejects.toThrow("research-step-not-current");
    for (let count = 1; count < 4; count++) await journal.model(digest, 1024);
    await expect(journal.model(digest, 1)).rejects.toThrow("research-model-limit");
    expect((await storage.get<ResearchState>("journal"))!.allocatedTokens).toBe(4096);
    controller.abort(); await expect(journal.read(digest)).rejects.toThrow();
  });
});

describe("research cloud custody recovery and retention", () => {
  it("never repeats a recovered research provider dispatch", async () => {
    const value = fixture(); value.binding.inputSha256 = await hostedTaskSha256(value.input); const cap = capabilityFixture(); cap.requestSha256 = await hostedTaskSha256(value);
    const storage = new MemoryTaskStorage(); const custody = new ProviderCustody(storage.context(), { MIVLET_HOSTED_TASK_SIGNING_KEY: "unit-signing-material-at-least-thirty-two", MIVLET_HOSTED_TASK_ENCRYPTION_KEY: "unit-encryption-material-separate-and-long" } as TaskEnv);
    await custody.enroll(cap, { credentialId: "credential-unit", providerId: "openai", revision: 1 }, secret); await custody.reserve(cap, value.binding, cap.requestSha256);
    const send = vi.fn(async () => { throw new Error("possible egress"); }); vi.stubGlobal("fetch", send);
    expect(await custody.run(cap.accountId, value.binding, value.input, cap.requestSha256)).toMatchObject({ ok: false, uncertain: true });
    const recovered = new ProviderCustody(storage.context(), {} as TaskEnv);
    expect(await recovered.run(cap.accountId, value.binding, value.input, cap.requestSha256)).toMatchObject({ ok: false, uncertain: true }); expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(Array.from(storage.values))).not.toContain(secret);
  });
  it("purges URL/query-bearing bindings and source metadata at 24 hours", async () => {
    vi.useFakeTimers(); const now = Date.now(); const storage = new MemoryTaskStorage();
    const task = new TaskAuthority(storage.context(), { PROVIDER_CUSTODY: { getByName: () => ({ release: async () => undefined }) } } as unknown as TaskEnv);
    await task.admit(capabilityFixture(), fixture()); vi.setSystemTime(now + 86_400_001); await task.alarm();
    expect(storage.values.size).toBe(0); expect(storage.alarmAt).toBeUndefined(); await expect(task.read(capabilityFixture())).rejects.toThrow("task-not-found");
  });
});
