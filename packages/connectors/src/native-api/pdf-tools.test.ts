import { expect, it, vi } from "vitest";
import { lookupTool } from "./tools";
import { buildToolApproval } from "./approvals";
import { effectForTool, evaluatePermissionPolicy } from "../permission-policy";
import { createToolExecutor, type ToolRuntime } from "./tool-executor";
import canonicalFixtures from "./approval-canonical-fixtures.json";

it("shares PDF reporting as a bounded write with exact-content approvals", () => {
  const tool = lookupTool("create-pdf")!;
  expect(tool).toMatchObject({ defaultMode: "full-access", defaultRisk: "high" });
  expect(effectForTool(tool.name)).toBe("local-write");
  expect(evaluatePermissionPolicy({ mode: "read-only", effect: "local-write", riskLevel: "high" }).allowed).toBe(false);
  const schema = JSON.parse(tool.parameters);
  expect(schema.properties.blocks.maxItems).toBe(200);
  expect(schema.properties.blocks.items.oneOf.every((shape: { additionalProperties: boolean }) => shape.additionalProperties === false)).toBe(true);
  const approvalFor = (tail: string) => buildToolApproval("codex", tool.name, JSON.stringify({ path: "report.pdf", title: "Report", blocks: [{ type: "paragraph", text: "x".repeat(400) + tail }] }));
  const first = approvalFor("original"), changed = approvalFor("changed");
  expect(first.confirmationPhrase).toBe("approve create-pdf");
  expect(first.dataUsed.filter(item => !item.startsWith("Arguments SHA-256:"))).toEqual(changed.dataUsed.filter(item => !item.startsWith("Arguments SHA-256:")));
  expect(first.dataUsed.find(item => item.startsWith("Arguments SHA-256:"))).not.toBe(changed.dataUsed.find(item => item.startsWith("Arguments SHA-256:")));
});

it.each(canonicalFixtures)("matches the native exact-content fixture: $name", fixture => {
  const approval = buildToolApproval("codex", "create-pdf", fixture.raw);
  expect(approval.dataUsed.find(item => item.startsWith("Arguments SHA-256:"))).toBe(fixture.digest);
});

it("dispatches PDF reports through the shared runtime only after a permitted grant", async () => {
  const authorOffice = vi.fn().mockResolvedValue("validated PDF");
  const runtime: ToolRuntime = {
    readFile: async () => null, writeFile: async () => 0,
    runShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }), fetchUrl: async () => null, authorOffice,
  };
  const args = JSON.stringify({ path: "report.pdf", title: "Report", blocks: [{ type: "paragraph", text: "Evidence" }] });
  const approval = buildToolApproval("openai", "create-pdf", args);
  await expect(createToolExecutor({ runtime, gate: { waitForDecision: async () => "denied" } })(approval, args)).rejects.toThrow("denied");
  await expect(createToolExecutor({ runtime, gate: { waitForDecision: async () => "granted" }, permissionMode: "read-only" })(approval, args)).rejects.toThrow();
  expect(authorOffice).not.toHaveBeenCalled();
  await expect(createToolExecutor({ runtime, gate: { waitForDecision: async () => "granted" } })(approval, args)).resolves.toBe("validated PDF");
  expect(authorOffice).toHaveBeenCalledWith("create-pdf", JSON.parse(args));
});
