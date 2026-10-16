import { describe, expect, it } from "vitest";
import {
  conversationComputerTools,
  isLocalComputerTool,
} from "./computer-tools";
describe("checkpoint provider tool admission", () => {
  it("uses computer scope/approval fencing and appears only when that authority is ready", () => {
    for (const action of ["list", "capture", "preview", "restore", "delete"]) {
      const name = `repository-checkpoint-${action}`;
      expect(isLocalComputerTool(name, "{}")).toBe(true);
      expect(
        conversationComputerTools([], true, false, { computer: true }).some(
          (tool) => tool.name === name,
        ),
      ).toBe(true);
      expect(
        conversationComputerTools([], false, false, { computer: true }).some(
          (tool) => tool.name === name,
        ),
      ).toBe(false);
      expect(
        conversationComputerTools([], true, false, { computer: false }).some(
          (tool) => tool.name === name,
        ),
      ).toBe(false);
    }
  });
});
