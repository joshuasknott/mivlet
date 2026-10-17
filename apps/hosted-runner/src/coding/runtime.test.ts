import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostedTaskSha256, HOSTED_CODING_IMAGE } from "@mivlet/protocol";
import { MemoryTaskStorage } from "../tasks/testing/fixtures";
import { byteSha256, utf8 } from "../tasks/coding-contracts";
import type { CodingCheckStart } from "../tasks/coding-runtime-contract";
import { CHILD_ISOLATION_PROBE } from "./scripts";

const calls = vi.hoisted(() => ({ get: vi.fn(), exec: vi.fn(), destroy: vi.fn() }));
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {
    constructor(protected ctx: DurableObjectState) {}
    exec(...args: unknown[]) { return calls.exec(...args); }
    async mkdir() { return { success: true }; }
    async writeFile() { return { success: true }; }
    async destroy() { calls.destroy(); }
    async alarm() {}
  }, getSandbox: (...args: unknown[]) => calls.get(...args),
}));
import handler, { CodingAuthority, OfflineCodingSandbox } from "./index";

const leaseId = "a".repeat(48);
async function value(source = "export const value = 1;\n"): Promise<CodingCheckStart> {
  const files = [{ path: "main.js", sizeBytes: utf8.encode(source).length, sha256: await byteSha256(utf8.encode(source)) }];
  return { leaseId, taskSha256: "b".repeat(64), stepId: "step-unit", deadline: Date.now() + 120000, files, candidateSha256: await hostedTaskSha256(files), scope: { writablePaths: ["main.js"], checks: [{ id: "syntax", argv: ["/usr/bin/node", "--check", "main.js"] }], image: HOSTED_CODING_IMAGE, network: "disabled" } };
}
function environment() { return { OFFLINE_CODING: {}, CODING_NETWORK_BASELINE: {} }; }
beforeEach(() => { calls.get.mockReset(); calls.exec.mockReset(); calls.destroy.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("private offline runtime authority", () => {
  it("has no public HTTP runtime surface", () => { expect(handler.fetch().status).toBe(404); });
  it("requires real positive HTTP/HTTPS/DNS controls before accepting all-negative isolation", async () => {
    const storage = new MemoryTaskStorage(); const observations: string[] = [];
    const sandbox = (name: string) => ({ exec: async (argv: string[]) => ({ output: async () => {
      if (argv[3] === CHILD_ISOLATION_PROBE) return { exitCode: 0, timedOut: false, truncated: false, stdout: JSON.stringify({ loopbackControlBaseline: true, unixControlBaseline: true, uidSeccomp: "uid-seccomp-v1" }) };
      observations.push(name); return { exitCode: 0, timedOut: false, truncated: false, stdout: JSON.stringify({ http: name.startsWith("fixed-baseline"), https: name.startsWith("fixed-baseline"), resolverDns: name.startsWith("fixed-baseline"), udpDns: name.startsWith("fixed-baseline"), privateTcp: false }) };
    } }), retire: vi.fn(async () => {}) });
    calls.get.mockImplementation((_ns, name: string) => sandbox(name));
    const authority = new CodingAuthority(storage.context(), environment() as never);
    await expect(authority.prove()).resolves.toMatchObject({ image: HOSTED_CODING_IMAGE, network: "disabled", proof: "positive-and-negative-v1" });
    expect(observations).toHaveLength(2); expect(await storage.get("probe")).toBeUndefined(); expect(await storage.get("proof")).toBeDefined();
    await authority.prove(); expect(observations).toHaveLength(2);
  });
  it("fails closed for unavailable controls, negative egress, or failed cleanup", async () => {
    for (const mode of ["missing-positive", "egress", "cleanup"]) {
      const storage = new MemoryTaskStorage();
      calls.get.mockImplementation((_ns, name: string) => ({ exec: async () => ({ output: async () => ({ exitCode: 0, timedOut: false, truncated: false, stdout: JSON.stringify({ http: name.startsWith("fixed-baseline") && mode !== "missing-positive", https: name.startsWith("fixed-baseline"), resolverDns: name.startsWith("fixed-baseline"), udpDns: name.startsWith("fixed-baseline") || mode === "egress", privateTcp: false }) }) }), retire: async () => { if (mode === "cleanup") throw new Error("not stopped"); } }));
      await expect(new CodingAuthority(storage.context(), environment() as never).prove()).rejects.toThrow(); expect(await storage.get("proof")).toBeUndefined();
    }
  });
  it("permanently retires SDK wake operations until bounded tombstone cleanup", async () => {
    vi.useFakeTimers(); const storage = new MemoryTaskStorage(); const sandbox = new OfflineCodingSandbox(storage.context(), {} as never);
    expect(sandbox.enableInternet).toBe(false); await sandbox.retire();
    await expect(sandbox.exec(["/usr/bin/python3", "-V"])).rejects.toThrow("coding-lease-retired"); expect(calls.exec).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000 + 1); await sandbox.alarm(); expect(storage.values.size).toBe(0);
  });
  it("does not stage another file or launch a command after Stop wins an in-flight stage", async () => {
    const storage = new MemoryTaskStorage(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn(async () => {}); const retire = vi.fn(async () => {});
    const mkdir = vi.fn(async () => { await pending; }); calls.get.mockReturnValue({ mkdir, writeFile: write, retire });
    const authority = new CodingAuthority(storage.context(), environment() as never); await authority.begin(await value());
    const stage = authority.file("main.js", "export const value = 1;\n");
    await vi.waitFor(() => expect(mkdir).toHaveBeenCalledOnce(), { timeout: 1000 });
    await authority.cancel(); release(); await expect(stage).rejects.toThrow("coding-check-not-current");
    expect(write).not.toHaveBeenCalled(); expect(retire).toHaveBeenCalledOnce(); await expect(authority.run("syntax")).rejects.toThrow();
  });
  it("retains cancellation before a delayed begin without creating any sandbox", async () => {
    const storage = new MemoryTaskStorage(); const authority = new CodingAuthority(storage.context(), environment() as never);
    await authority.cancel(); await expect(authority.begin(await value())).rejects.toThrow("coding-lease-already-used"); expect(calls.get).not.toHaveBeenCalled();
  });
  it("stages BOM source through runtime authority with the exact manifest hash and SDK bytes", async () => {
    const source = "\uFEFFexport const value = 1;\n"; const write = vi.fn(async (_path: string, _content: string) => {});
    calls.get.mockReturnValue({ mkdir: async () => {}, writeFile: write, retire: async () => {} });
    const storage = new MemoryTaskStorage(); const authority = new CodingAuthority(storage.context(), environment() as never);
    const start = await value(source); await authority.begin(start); await authority.file("main.js", source);
    expect(write).toHaveBeenCalledWith("/workspace/task/main.js", source);
    expect(await byteSha256(utf8.encode(vi.mocked(write).mock.calls[0][1]))).toBe(start.files[0].sha256);
    await authority.cancel();
  });
  it("launches exact fixed wrapper once and rejects a repeated possibly executed check", async () => {
    const storage = new MemoryTaskStorage(); const exec = vi.fn(async () => ({ output: async () => ({ exitCode: 0, timedOut: false, truncated: false, stdout: JSON.stringify({ exitCode: 0, stdout: "checked", stderr: "", truncated: false, timedOut: false }) }) }));
    const write = vi.fn(async () => {}); const retire = vi.fn(async () => {}); calls.get.mockReturnValue({ mkdir: async () => {}, writeFile: write, exec, retire });
    const authority = new CodingAuthority(storage.context(), environment() as never); const start = await value(); await authority.begin(start); await authority.file("main.js", "export const value = 1;\n");
    await expect(authority.run("other")).rejects.toThrow(); expect(exec).not.toHaveBeenCalled();
    const result = await authority.run("syntax"); expect(result).toMatchObject({ candidateSha256: start.candidateSha256, id: "syntax", exitCode: 0 });
    expect(exec.mock.calls[0][0].slice(0, 3)).toEqual(["/usr/bin/python3", "-I", "-c"]); expect(exec.mock.calls[0][0]).toHaveLength(4);
    expect(write).toHaveBeenCalledWith("/workspace/.mivlet-check.json", expect.stringContaining('"argv":["/usr/bin/node","--check","main.js"]'));
    await expect(authority.run("syntax")).rejects.toThrow(); expect(exec).toHaveBeenCalledOnce(); expect(retire).toHaveBeenCalledOnce();
  });
});
