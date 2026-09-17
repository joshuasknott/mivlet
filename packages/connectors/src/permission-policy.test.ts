import { describe, expect, it } from "vitest";
import type { ApprovalRiskLevel, PermissionMode } from "@mivlet/protocol";
import { COLLABORATION_TOOLS } from "./native-api/collaboration-tools";
import { registeredToolSpecs } from "./native-api/tools";
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
  resolvePermissionModeFromCustom,
  type PermissionEffect
} from "./permission-policy";
import vocabulary from "./permission-policy.json" with { type: "json" };

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
    for (const effect of [
      "local-write",
      "connector-write",
      "app-state-mutation",
      "browser-state-mutation",
      "delete",
      "publish-external",
      "memory-promotion"
    ] as const) {
      const decision = evaluatePermissionPolicy({ mode: "trusted-scope", effect });
      expect(decision.allowed).toBe(true);
      expect(decision.approvalRequired).toBe(true);
    }
    expect(evaluatePermissionPolicy({ mode: "trusted-scope", effect: "shell-execution" }).allowed).toBe(false);
    expect(evaluatePermissionPolicy({ mode: "trusted-scope", effect: "cache-mutation" }).allowed).toBe(false);
  });

  it("ensures full-access mode allows consequential actions but still requires approval/permits", () => {
    for (const effect of [
      "local-write",
      "shell-execution",
      "connector-write",
      "cache-mutation",
      "app-state-mutation",
      "delete",
      "publish-external",
      "memory-promotion",
      "browser-state-mutation"
    ] as const) {
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
    expect(effectForTool("teammate-assign")).toBe("coordination");
    expect(effectForTool("connector-call")).toBe("connector-write");
    expect(effectForTool("connector-action")).toBe("connector-write");
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

describe("shared permission-policy vocabulary", () => {
  const modes = Object.keys(vocabulary.profileForMode) as PermissionMode[];
  const risks = ["low", "medium", "high", "critical"] as const satisfies readonly ApprovalRiskLevel[];
  const readOnlyAllowed = new Set(vocabulary.readOnlyAllowed);
  const trustedAllowed = new Set(vocabulary.trustedAllowed);
  const consequential = new Set(vocabulary.consequentialEffects);
  const highRisks = new Set(vocabulary.highRisks);

  function expectedDecision(mode: PermissionMode, effect: PermissionEffect, riskLevel: ApprovalRiskLevel) {
    const profile = vocabulary.profileForMode[mode];
    const allowed =
      profile === "read-only"
        ? readOnlyAllowed.has(effect)
        : profile === "trusted"
          ? trustedAllowed.has(effect)
          : true;
    if (!allowed) {
      return { allowed: false, approvalRequired: false };
    }
    return {
      allowed: true,
      approvalRequired:
        consequential.has(effect) || effect === "web-fetch" || highRisks.has(riskLevel)
    };
  }

  it("keeps allow-sets, severity, and profile maps internally consistent", () => {
    expect(new Set(vocabulary.effects).size).toBe(vocabulary.effects.length);
    expect(vocabulary.readOnlyAllowed.every((effect) => trustedAllowed.has(effect))).toBe(true);
    expect(trustedAllowed.has("shell-execution")).toBe(false);
    expect(trustedAllowed.has("cache-mutation")).toBe(false);
    expect(vocabulary.highSeverityEffects.every((effect) => consequential.has(effect))).toBe(true);
    expect(
      new Set([...vocabulary.connectorDeleteActions, ...vocabulary.connectorPublishActions]).size
    ).toBe(vocabulary.connectorDeleteActions.length + vocabulary.connectorPublishActions.length);
    expect(permissionProfileForMode("trusted-scope")).toBe(vocabulary.profileForMode["trusted-scope"]);
    expect(permissionModeForProfile("trusted")).toBe("trusted-scope");
  });

  it("matches the shared decision matrix for every effect, mode, and risk", () => {
    for (const mode of modes) {
      for (const effect of vocabulary.effects as PermissionEffect[]) {
        for (const riskLevel of risks) {
          expect(
            evaluatePermissionPolicy({ mode, effect, riskLevel }),
            `${mode} ${effect} ${riskLevel}`
          ).toMatchObject(expectedDecision(mode, effect, riskLevel));
        }
      }
    }
  });

  it("maps every registered tool and shared action table through the same lookups", () => {
    for (const [tool, effect] of Object.entries(vocabulary.toolEffects)) {
      expect(effectForTool(tool), tool).toBe(effect);
    }
    expect(effectForTool("local-browser")).toBeNull();
    for (const spec of registeredToolSpecs()) {
      expect(effectForTool(spec.name), spec.name).not.toBeNull();
    }
    for (const name of Object.keys(COLLABORATION_TOOLS)) {
      expect(effectForTool(name), name).toBe("coordination");
    }
    for (const [action, effect] of Object.entries(vocabulary.browserActionEffects)) {
      expect(effectForBrowserAction(action), action).toBe(effect);
    }
    expect(effectForBrowserAction("browser.dom-dump")).toBeNull();
    for (const action of vocabulary.connectorDeleteActions) {
      expect(effectForConnectorAction(action), action).toBe("delete");
    }
    for (const action of vocabulary.connectorPublishActions) {
      expect(effectForConnectorAction(action), action).toBe("publish-external");
    }
    expect(effectForConnectorAction("gmail.create-draft")).toBe("connector-write");
    expect(effectForConnectorAction("unknown.write")).toBe("connector-write");
    expect(evaluatePermissionPolicy({ mode: "read-only", effect: "coordination" }).allowed).toBe(true);
  });
});
