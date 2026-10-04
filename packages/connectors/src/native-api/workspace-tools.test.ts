import { expect, it, vi } from "vitest";
import { buildToolApproval } from "./approvals";
import { lookupTool } from "./tools";
import { effectForTool } from "../permission-policy";
import { createToolExecutor, type ToolRuntime } from "./tool-executor";

const argumentsJson = JSON.stringify({ command: "python3 analysis.py", inputs: ["data.csv", "analysis.py"], outputs: ["report.csv"], network: false, timeoutSeconds: 30 });
const runtime = (): ToolRuntime => ({ readFile: async () => null, writeFile: async () => 0, fetchUrl: async () => null, runShell: vi.fn() });

it("shares projectless analysis with an explicit network consequence and exact payload", () => {
  const spec = lookupTool("workspace-run")!;
  expect(spec).toMatchObject({ defaultMode: "full-access", defaultRisk: "critical" });
  expect(effectForTool(spec.name)).toBe("shell-execution");
  const first = buildToolApproval("openai", spec.name, argumentsJson);
  expect(first.consequence).toContain("Network: disabled");
  const network = buildToolApproval("claude-agent", spec.name, argumentsJson.replace('"network":false', '"network":true'));
  expect(network.consequence).toContain("internetClient capability; no private-network or loopback exemption");
  const digest = (approval: typeof first) => approval.dataUsed.find(item => item.startsWith("Arguments SHA-256:"));
  expect(digest(first)).not.toBe(digest(network));
  expect(digest(first)).not.toBe(digest(buildToolApproval("openai", spec.name, argumentsJson.replace("report.csv", "other.csv"))));
});

it("fails closed without the projectless boundary and never falls back to a shell", async () => {
  const r = runtime();
  const approval = buildToolApproval("codex", "workspace-run", argumentsJson);
  await expect(createToolExecutor({ runtime: r, gate: { waitForDecision: async () => "granted" } })(approval, argumentsJson)).rejects.toThrow("unavailable");
  expect(r.runShell).not.toHaveBeenCalled();
});

it("requires a grant and Full Access before calling the shared analysis boundary", async () => {
  const r = { ...runtime(), runWorkspace: vi.fn().mockResolvedValue('{"command":{"exitCode":0},"outputs":[]}') };
  const approval = buildToolApproval("anthropic", "workspace-run", argumentsJson);
  await expect(createToolExecutor({ runtime: r, gate: { waitForDecision: async () => "denied" } })(approval, argumentsJson)).rejects.toThrow("denied");
  await expect(createToolExecutor({ runtime: r, permissionMode: "read-only", gate: { waitForDecision: async () => "granted" } })(approval, argumentsJson)).rejects.toThrow("Permission denied");
  expect(r.runWorkspace).not.toHaveBeenCalled();
  await createToolExecutor({ runtime: r, gate: { waitForDecision: async () => "granted" } })(approval, argumentsJson);
  expect(r.runWorkspace).toHaveBeenCalledExactlyOnceWith(JSON.parse(argumentsJson));
  expect(r.runShell).not.toHaveBeenCalled();
});
