import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";
import { lookupTool } from "./tools";

describe("native command lifecycle permits", () => {
  it("binds every persistent command and lifetime change to an exact approval", () => {
    for (const name of ["repository-start", "workspace-start"]) {
      const args = {
        command: `${"echo check\n".repeat(40)}node server.js`,
        network: false,
        timeoutSeconds: 600,
        ...(name === "repository-start"
          ? { repositoryId: "repo" }
          : { inputs: ["server.js"] }),
      };
      const initial = buildToolApproval("codex", name, JSON.stringify(args));
      expect(initial.consequence).toContain("All writes discarded");
      expect(initial.consequence).toContain("600 seconds");
      expect(initial.riskLevel).toBe("critical");
      for (const change of [
        { command: `${args.command} changed` },
        { network: true },
        { timeoutSeconds: 601 },
        { interactive: true },
        ...(name === "repository-start" ? [{ previewPort: 4173 }] : []),
      ]) {
        const changed = buildToolApproval(
          "codex",
          name,
          JSON.stringify({ ...args, ...change }),
        );
        expect(changed.dataUsed).not.toEqual(initial.dataUsed);
      }
    }
  });
  it("binds exact input bytes, sequence and job identity to an explicit mutation approval", () => {
    const args = { jobId: "one", jobGeneration: 2, inputSequence: 1, text: "inspect\n" };
    const initial = buildToolApproval("codex", "command-input", JSON.stringify(args));
    expect(initial.mode).toBe("full-access");
    expect(initial.riskLevel).toBe("high");
    for (const change of [{ text: "inspect" }, { inputSequence: 2 }, { jobGeneration: 3 }, { jobId: "two" }]) {
      expect(buildToolApproval("codex", "command-input", JSON.stringify({ ...args, ...change })).dataUsed).not.toEqual(initial.dataUsed);
    }
    expect(lookupTool("command-input")?.parameters).toContain("inputSequence");
  });
  it("binds exact stop identity and generation and exposes only bounded read operations", () => {
    const initial = buildToolApproval(
      "codex",
      "command-stop",
      JSON.stringify({ jobId: "one", jobGeneration: 2 }),
    );
    const changed = buildToolApproval(
      "codex",
      "command-stop",
      JSON.stringify({ jobId: "one", jobGeneration: 3 }),
    );
    expect(changed.dataUsed).not.toEqual(initial.dataUsed);
    expect(initial.consequence).toContain("all descendants");
    expect(lookupTool("command-output")?.defaultMode).toBe("read-only");
    expect(lookupTool("command-output")?.parameters).toContain("cursor");
    expect(lookupTool("command-jobs")).toBeDefined();
    expect(lookupTool("command-stdin")).toBeUndefined();
  });
});
