import { describe, expect, it, vi } from "vitest";
import { executeHostedAgentRoutine } from "./agent-routine-execution";

const baseRequest = {
  requestKey: "routine-request-123",
  routineId: "routine-workspace-review-123",
  runId: "routine-workspace-review",
  title: "Workspace review",
  instruction: "Read notes and update the summary.",
  firstRunAt: "2026-08-25T13:00:00.000Z",
  intervalSeconds: 3_600,
  capabilities: ["workspace-read"] as const,
  maxSteps: 4
};

function sandboxDouble() {
  return {
    listFiles: vi.fn(async () => ({
      success: true,
      files: [{ absolutePath: "/workspace/notes.md", type: "file", size: 12, modifiedAt: "2026-08-25T12:00:00.000Z" }],
      count: 1
    })),
    readFile: vi.fn(async () => ({ success: true, content: "hello", size: 5, isBinary: false })),
    mkdir: vi.fn(async () => ({ success: true })),
    writeFile: vi.fn(async () => ({ success: true })),
    renameFile: vi.fn(async () => ({ success: true })),
    deleteFile: vi.fn(async () => ({ success: true })),
    exec: vi.fn(async () => ({
      output: vi.fn(async () => ({ stdout: "done", stderr: "", exitCode: 0, timedOut: false, truncated: false }))
    }))
  };
}

describe("hosted natural-language routine execution", () => {
  it("only exposes tools covered by the approved standing capabilities", async () => {
    const sandbox = sandboxDouble();
    const runWithToolsImpl = vi.fn(async (_ai, _model, input) => {
      expect(input.tools.map((tool: { name: string }) => tool.name)).toEqual(["workspace_list", "workspace_read"]);
      const read = input.tools.find((tool: { name: string }) => tool.name === "workspace_read");
      await read?.function?.({ path: "/workspace/notes.md" });
      return { response: "Reviewed /workspace/notes.md." };
    });
    const result = await executeHostedAgentRoutine({
      ai: {},
      sandbox: sandbox as never,
      request: baseRequest,
      runWithToolsImpl: runWithToolsImpl as never
    });
    expect(result).toEqual({
      result: "Reviewed /workspace/notes.md.",
      tools: [{ tool: "workspace-read", summary: "Read /workspace/notes.md", status: "completed" }]
    });
    expect(sandbox.readFile).toHaveBeenCalledWith("/workspace/notes.md", { encoding: "utf8" });
  });

  it("atomically writes files and runs explicit argv when both capabilities were approved", async () => {
    const sandbox = sandboxDouble();
    const runWithToolsImpl = vi.fn(async (_ai, _model, input) => {
      const write = input.tools.find((tool: { name: string }) => tool.name === "workspace_write");
      const run = input.tools.find((tool: { name: string }) => tool.name === "process_run");
      await write?.function?.({ path: "/workspace/reports/weekly.md", content: "ready" });
      await run?.function?.({ argvJson: "[\"node\",\"check.mjs\"]", cwd: "/workspace", timeoutMs: 5_000 });
      return { response: "Updated and checked /workspace/reports/weekly.md." };
    });
    const result = await executeHostedAgentRoutine({
      ai: {},
      sandbox: sandbox as never,
      request: {
        ...baseRequest,
        capabilities: ["workspace-read", "workspace-write", "process-run"]
      },
      runWithToolsImpl: runWithToolsImpl as never
    });
    expect(result.tools.map((tool) => [tool.tool, tool.status])).toEqual([
      ["workspace-write", "completed"],
      ["process-run", "completed"]
    ]);
    expect(sandbox.mkdir).toHaveBeenCalledWith("/workspace/reports", { recursive: true });
    expect(sandbox.renameFile).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/\.fable\/routine-write-/), "/workspace/reports/weekly.md");
    expect(sandbox.exec).toHaveBeenCalledWith(["node", "check.mjs"], { cwd: "/workspace", timeout: 5_000 });
  });

  it("denies traversal and internal-state access before touching the sandbox", async () => {
    const sandbox = sandboxDouble();
    const runWithToolsImpl = vi.fn(async (_ai, _model, input) => {
      const read = input.tools.find((tool: { name: string }) => tool.name === "workspace_read");
      await expect(read?.function?.({ path: "/workspace/.fable/computer.json" })).rejects.toThrow(/internal/i);
      return { response: "Blocked unsafe access." };
    });
    await executeHostedAgentRoutine({
      ai: {},
      sandbox: sandbox as never,
      request: baseRequest,
      runWithToolsImpl: runWithToolsImpl as never
    });
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });
});
