import { describe, expect, it } from "vitest";
import { builtInDepartments, departmentPipelines, planDepartmentPipeline } from "./builtins";

describe("built-in departments", () => {
  it("serializes Research and Ship as narrow workflow-backed pipelines", () => {
    const departments = builtInDepartments("2026-06-29T00:00:00.000Z");

    expect(departments.map((department) => department.id)).toEqual(["research", "ship"]);
    expect(JSON.parse(JSON.stringify(departments))).toEqual(departments);
    expect(departments.flatMap((department) => department.pipelines)).toHaveLength(2);
    expect(departments[0]?.pipelines[0]?.workflow.schemaVersion).toBe(1);
  });

  it("plans missing connector needs without live auth", () => {
    const research = departmentPipelines("2026-06-29T00:00:00.000Z").find(
      (pipeline) => pipeline.id === "research-context-brief"
    );

    expect(research).toBeDefined();
    const blocked = planDepartmentPipeline(research!, []);
    expect(blocked.runnable).toBe(false);
    expect(blocked.missingConnectors.map((need) => need.connectorId)).toEqual(["github"]);

    const runnable = planDepartmentPipeline(research!, ["github"]);
    expect(runnable.runnable).toBe(true);
    expect(runnable.stepOrder).toEqual(["gather-knowledge", "read-github", "synthesize-brief"]);
  });

  it("keeps Ship writes behind a fresh approval requirement", () => {
    const ship = departmentPipelines("2026-06-29T00:00:00.000Z").find(
      (pipeline) => pipeline.id === "ship-release-check"
    );

    expect(ship).toBeDefined();
    expect(ship!.connectorNeeds.filter((need) => need.access === "write")).toEqual([
      expect.objectContaining({ connectorId: "github", optional: true }),
      expect.objectContaining({ connectorId: "slack", optional: true })
    ]);

    const plan = planDepartmentPipeline(ship!, ["vercel"]);
    expect(plan.runnable).toBe(true);
    expect(plan.approvalRequirement.kind).toBe("fresh-explicit");
    expect(plan.runtimeRoute.permissionMode).toBe("trusted-scope");
    expect(plan.stepOrder.at(-1)).toBe("approve-connector-writes");
  });
});
