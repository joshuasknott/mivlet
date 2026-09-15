import { beforeEach, expect, it, vi } from "vitest";
import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

const native = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn() }));
vi.mock("../runtime/domains/connectors", () => ({
prepareRuntimeConnectorToolAction: native.prepare,
executeRuntimeConnectorAction: native.execute
}));
const payload = { to: "recipient@example.test", subject: "Review", body: "Proposed text" };
const args = JSON.stringify({ connectorId: "gmail", action: "gmail.send", payload });
const wrapper = buildToolApproval("Codex", "connector-action", args);
const prepared = { action: { id: "native-1", connectorId: "gmail", action: "gmail.send", payload,
  approval: { ...wrapper, id: "native-1", action: "Send", service: "Gmail" } }, preview: "Account: selected account\nTo: recipient@example.test\nSubject: Review", connectionId: "connection_prepared" };
beforeEach(() => { vi.clearAllMocks(); native.prepare.mockResolvedValue(prepared); native.execute.mockResolvedValue({ status: "completed" }); });

it("prepares the exact native write and waits for one decision before execution", async () => {
  const waitForDecision = vi.fn().mockResolvedValue("granted");
  const queueApproval = vi.fn();
  const execute = createDesktopToolExecutor({ waitForDecision }, { workspaceId: "w", connectorIds: ["gmail"], queueApproval });
  expect(await execute(wrapper, args)).toContain('"status":"completed"');
  expect(native.prepare).toHaveBeenCalledWith("w", "gmail", "gmail.send", payload);
  expect(waitForDecision).toHaveBeenCalledExactlyOnceWith(prepared.action.approval);
  expect(queueApproval).toHaveBeenCalledWith(prepared.action.approval, "connector-action", JSON.stringify({ preview: prepared.preview, payload }));
  expect(native.execute).toHaveBeenCalledWith({ action: prepared.action, approval: expect.objectContaining({ request: prepared.action.approval, decision: "once" }) });
});

it("denial prevents the native write", async () => {
  const execute = createDesktopToolExecutor({ waitForDecision: async () => "denied" }, { workspaceId: "w", connectorIds: ["gmail"], queueApproval: vi.fn() });
  await expect(execute(wrapper, args)).rejects.toThrow("denied");
  expect(native.execute).not.toHaveBeenCalled();
});

it("revoked agent access prevents execution after approval", async () => {
  let allowed = true;
  const execute = createDesktopToolExecutor({ waitForDecision: async () => { allowed = false; return "granted"; } }, { workspaceId: "w", connectorAccessCurrent: () => allowed, queueApproval: vi.fn() });
  await expect(execute(wrapper, args)).rejects.toThrow("access changed");
  expect(native.execute).not.toHaveBeenCalled();
});

it("account switch during approval fails closed instead of using the newly selected account", async () => {
  let currentAccount = prepared.connectionId;
  const execute = createDesktopToolExecutor({ waitForDecision: async () => { currentAccount = "connection_other"; return "granted"; } }, {
    workspaceId: "w",
    connectorIds: ["gmail"],
    connectorAccountCurrent: () => currentAccount,
    queueApproval: vi.fn(),
  });
  await expect(execute(wrapper, args)).rejects.toThrow("connected account changed");
  expect(native.execute).not.toHaveBeenCalled();
});

it("executes against the prepared account when selection is unchanged", async () => {
  const execute = createDesktopToolExecutor({ waitForDecision: async () => "granted" }, {
    workspaceId: "w",
    connectorIds: ["gmail"],
    connectorAccountCurrent: () => prepared.connectionId,
    queueApproval: vi.fn(),
  });
  expect(await execute(wrapper, args)).toContain('"status":"completed"');
  expect(native.execute).toHaveBeenCalledWith({ action: prepared.action, approval: expect.objectContaining({ request: prepared.action.approval, decision: "once" }) });
});

it("unselected apps and malformed payloads fail before preparation", async () => {
  const execute = createDesktopToolExecutor({ waitForDecision: vi.fn() }, { workspaceId: "w", connectorIds: [] });
  await expect(execute(wrapper, args)).rejects.toThrow("Select or mention");
  expect(native.prepare).not.toHaveBeenCalled();
});
