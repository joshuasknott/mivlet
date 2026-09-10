import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_APPROVAL_SETTINGS,
  effectForBrowserAction,
  effectForConnectorAction,
  effectForTool,
  evaluatePermissionPolicy,
  isHighSeverityEffect,
  normalizeCustomApprovalSettings,
  normalizePermissionProfile,
  permissionModeForProfile,
  permissionProfileForMode,
  resolvePermissionModeFromCustom
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

  it("blocks read-only writes, shell execution, sends, and deletes", () => {
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "local-read" }).allowed).toBe(true);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "local-write" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "shell-execution" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "connector-write" }).allowed).toBe(false);
  });

  it("ensures trusted mode allows reads and safe writes through approval while blocking shell", () => {
    // Allowed with approval required (consequential)
    for (const effect of ["local-write", "connector-write", "app-state-mutation"] as const) {
      const decision = evaluatePermissionPolicy({ mode: "trusted-scope", effect });
      expect(decision.allowed).toBe(true);
      expect(decision.approvalRequired).toBe(true);
    }
    // Blocked entirely
    expect(evaluatePermissionPolicy({ mode: "trusted-scope", effect: "shell-execution" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "trusted-scope", effect: "cache-mutation" }).allowed).toBe(false);
  });

  it("ensures full-access mode allows consequential actions but still requires approval/permits", () => {
    for (const effect of ["local-write", "shell-execution", "connector-write", "cache-mutation", "app-state-mutation"] as const) {
      const decision = evaluatePermissionPolicy({ mode: "full-access", effect });
      expect(decision.allowed).toBe(true);
      expect(decision.approvalRequired).toBe(true);
    }
  });

  it("maps registered tools to effects", () => {
    expect(effectForTool("read-file")).toBe("local-read");
    expect(effectForTool("write-file")).toBe("local-write");
    expect(effectForTool("create-spreadsheet")).toBe("local-write");
    expect(effectForTool("create-document")).toBe("local-write");
    expect(effectForTool("run-shell")).toBe("shell-execution");
    expect(effectForTool("local-browser")).toBeNull();
    expect(effectForTool("local-app-observe")).toBe("browser-read");
    expect(effectForTool("local-app-action")).toBe("browser-state-mutation");
    expect(effectForTool("cloud-browser")).toBe("browser-state-mutation");
    expect(effectForTool("cloud-browser-action")).toBe("browser-state-mutation");
    expect(effectForTool("connection-read")).toBe("connector-read");
    expect(effectForTool("gmail-read")).toBe("connector-read");
  });

  it("maps browser automation actions onto the shared permission effects", () => {
    expect(effectForBrowserAction("browser.read-url")).toBe("browser-read");
    expect(effectForBrowserAction("browser.click")).toBe("browser-state-mutation");
    expect(effectForBrowserAction("browser.submit")).toBe("publish-external");
    expect(effectForBrowserAction("browser.download")).toBe("local-write");
    expect(effectForBrowserAction("browser.dom-dump")).toBeNull();
  });
});

describe("plain approval choices map to one strict policy", () => {
  it("classifies connector deletes and external sends conservatively", () => {
    expect(effectForConnectorAction("google-drive.delete-file")).toBe("delete");
    expect(effectForConnectorAction("gmail.send")).toBe("publish-external");
    expect(effectForConnectorAction("unknown.write")).toBe("connector-write");
  });

  it("marks every consequential external category as high severity", () => {
    for (const effect of [
      "delete",
      "shell-execution",
      "connector-write",
      "publish-external",
      "cache-mutation",
      "memory-promotion",
      "browser-state-mutation"
    ] as const) {
      expect(isHighSeverityEffect(effect)).toBe(true);
    }
  });

  it("Ask Me permits bounded changes only through approval and blocks shell", () => {
    const local = evaluatePermissionPolicy({
      mode: "trusted-scope",
      effect: "local-write"
    });
    const connector = evaluatePermissionPolicy({
      mode: "trusted-scope",
      effect: "connector-write"
    });
    expect(local).toMatchObject({ allowed: true, approvalRequired: true });
    expect(connector).toMatchObject({ allowed: true, approvalRequired: true });
    expect(
      evaluatePermissionPolicy({ mode: "trusted-scope", effect: "shell-execution" }).allowed
    ).toBe(false);
  });

  it("Work Freely still requires approval for every high-severity effect", () => {
    for (const effect of [
      "delete",
      "shell-execution",
      "connector-write",
      "publish-external",
      "cache-mutation",
      "memory-promotion",
      "browser-state-mutation"
    ] as const) {
      expect(
        evaluatePermissionPolicy({ mode: "full-access", effect })
      ).toMatchObject({ allowed: true, approvalRequired: true });
    }
  });

  it("allows browser reads in read-only mode but requires approval for browser control", () => {
    expect(
      evaluatePermissionPolicy({ mode: "read-only", effect: "browser-read" })
    ).toMatchObject({ allowed: true, approvalRequired: false });
    expect(
      evaluatePermissionPolicy({ mode: "trusted-scope", effect: "browser-state-mutation" })
    ).toMatchObject({ allowed: true, approvalRequired: true });
    expect(
      evaluatePermissionPolicy({ mode: "read-only", effect: "browser-state-mutation" })
    ).toMatchObject({ allowed: false, approvalRequired: false });
  });
});

describe("Custom settings resolve to the existing modes", () => {
  it("defaults to the narrowest mode", () => {
    expect(resolvePermissionModeFromCustom(DEFAULT_CUSTOM_APPROVAL_SETTINGS)).toBe("read-only");
  });

  it("widens only through the two explicit toggles", () => {
    expect(
      resolvePermissionModeFromCustom({
        allowSmallLocalEdits: true,
        allowPowerfulCommands: false
      })
    ).toBe("trusted-scope");
    expect(
      resolvePermissionModeFromCustom({
        allowSmallLocalEdits: false,
        allowPowerfulCommands: true
      })
    ).toBe("full-access");
  });

  it("fills missing persisted values with safe defaults", () => {
    expect(normalizeCustomApprovalSettings({ allowSmallLocalEdits: true })).toEqual({
      allowSmallLocalEdits: true,
      allowPowerfulCommands: false
    });
  });
});
