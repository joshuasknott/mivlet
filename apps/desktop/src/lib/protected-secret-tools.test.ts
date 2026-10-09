import { describe, expect, it, vi } from "vitest";
import type { BackendProvider } from "@mivlet/protocol";
import { buildToolApproval } from "@mivlet/connectors/native-api/approvals";
import { conversationToolsForModel, isLocalComputerTool } from "./computer-tools";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

const native = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../runtime/domains/tools", () => ({ executeRuntimeToolCall: native.execute }));
const provider = { backendType: "codex-app-server", authState: "connected", capabilities: ["tool-requests"] } as BackendProvider;
const model = { id: "model", label: "Model", available: true };
const computer = { ready: true, controller: "agent" as const, generation: 7, workspaceId: "default", agentId: "agent" };
const args = JSON.stringify({ label: "Release signing key", reason: "Verify release events", consumer: "webhook-signing-key", purpose: "verify-webhook-signature", targetId: "release" });

describe("protected request invocation", () => {
  it("uses the shared provider bridge and generation without granting computer control", () => {
    const available = conversationToolsForModel([], true, provider, model, { computer: false }, false, false);
    expect(available.map(t => t.name)).toContain("request-secret");
    expect(available.map(t => t.name)).not.toContain("local-app-select");
    expect(isLocalComputerTool("request-secret", args)).toBe(true);
    expect(conversationToolsForModel([], true, { ...provider, authState: "sign-in-required" }, model, { computer: false }).map(t => t.name)).not.toContain("request-secret");
  });
  it("passes only metadata after exact scoped approval and returns an opaque reference", async () => {
    native.execute.mockReset().mockResolvedValue({ ok: true, output: JSON.stringify({ status: "ready", secretRef: "secret-ref:opaque" }) });
    const queued = vi.fn();
    const executor = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, { localComputer: computer, queueApproval: queued });
    const result = await executor(buildToolApproval("codex", "request-secret", args), args);
    expect(JSON.parse(result)).toEqual({ status: "ready", secretRef: "secret-ref:opaque" });
    expect(queued.mock.calls[0][0].dataUsed).toContain("Computer generation: 7");
    expect(native.execute).toHaveBeenCalledWith(expect.objectContaining({ tool: "request-secret", arguments: JSON.parse(args), computerGeneration: 7, agentId: "agent" }));
  });
  it("refuses Stop or generation changes while waiting for approval", async () => {
    native.execute.mockReset();
    let current = computer;
    const executor = createDesktopToolExecutor({ waitForDecision: async () => { current = { ...computer, generation: 8 }; return "granted"; } }, { localComputer: computer, localComputerCurrent: () => current });
    await expect(executor(buildToolApproval("codex", "request-secret", args), args)).rejects.toThrow(/control changed/i);
    expect(native.execute).not.toHaveBeenCalled();
  });
});
