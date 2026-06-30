import { describe, expect, it } from "vitest";
import {
  effectForTool,
  evaluatePermissionPolicy,
  normalizePermissionProfile,
  permissionModeForProfile,
  permissionProfileForMode
} from "./permission-policy";

describe("permission profile policy", () => {
  it("preserves public modes while exposing user-facing profiles", () => {
    expect(permissionProfileForMode("read-only")).toBe("read-only");
    expect(permissionProfileForMode("trusted-scope")).toBe("trusted");
    expect(permissionProfileForMode("full-access")).toBe("full-with-approvals");
    expect(permissionModeForProfile("trusted")).toBe("trusted-scope");
    expect(normalizePermissionProfile({ profile: "full-with-approvals" })).toEqual({
      profile: "full-with-approvals",
      mode: "full-access"
    });
  });

  it("blocks read-only writes, shell execution, sends/deletes, and schedule mutation/execution", () => {
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "local-read" }).allowed).toBe(true);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "local-write" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "shell-execution" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "schedule-execution" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "schedule-mutation" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "connector-write" }).allowed).toBe(false);
  });

  it("ensures trusted mode allows reads, safe writes, schedule actions, but requires approvals for consequential actions, while blocking shell", () => {
    // Allowed with approval required (consequential)
    for (const effect of ["local-write", "connector-write", "app-state-mutation", "schedule-mutation", "schedule-execution"] as const) {
      const decision = evaluatePermissionPolicy({ mode: "trusted-scope", effect });
      expect(decision.allowed).toBe(true);
      expect(decision.approvalRequired).toBe(true);
    }
    // Blocked entirely
    expect(evaluatePermissionPolicy({ mode: "trusted-scope", effect: "shell-execution" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "trusted-scope", effect: "cache-mutation" }).allowed).toBe(false);
  });

  it("ensures full-access mode allows consequential actions but still requires approval/permits", () => {
    for (const effect of ["local-write", "shell-execution", "connector-write", "cache-mutation", "app-state-mutation", "schedule-mutation", "schedule-execution"] as const) {
      const decision = evaluatePermissionPolicy({ mode: "full-access", effect });
      expect(decision.allowed).toBe(true);
      expect(decision.approvalRequired).toBe(true);
    }
  });

  it("maps registered tools to effects", () => {
    expect(effectForTool("read-file")).toBe("local-read");
    expect(effectForTool("write-file")).toBe("local-write");
    expect(effectForTool("run-shell")).toBe("shell-execution");
    expect(effectForTool("gmail-read")).toBe("connector-read");
  });
});
