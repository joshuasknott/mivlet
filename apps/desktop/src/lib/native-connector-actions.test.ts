import { beforeEach, expect, it, vi } from "vitest";
import { buildToolApproval } from "@mivlet/connectors/native-api/approvals";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

const native = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn() }));
vi.mock("../runtime/domains/connectors", () => ({
  prepareRuntimeConnectorToolAction: native.prepare,
  executeRuntimeConnectorAction: native.execute,
}));
const payload = {
  to: "recipient@example.test",
  subject: "Review",
  body: "Proposed text",
};
const args = JSON.stringify({
  connectorId: "gmail",
  action: "gmail.send",
  payload,
});
const wrapper = buildToolApproval("Codex", "connector-action", args);
const prepared = {
  action: {
    id: "native-1",
    connectorId: "gmail",
    action: "gmail.send",
    payload,
    approval: { ...wrapper, id: "native-1", action: "Send", service: "Gmail" },
  },
  preview:
    "Account: selected account\nTo: recipient@example.test\nSubject: Review",
  connectionId: "connection_prepared",
};
beforeEach(() => {
  vi.clearAllMocks();
  native.prepare.mockResolvedValue(prepared);
  native.execute.mockResolvedValue({ status: "completed" });
});

it("prepares the exact native write and waits for one decision before execution", async () => {
  const waitForDecision = vi.fn().mockResolvedValue("granted");
  const queueApproval = vi.fn();
  const execute = createDesktopToolExecutor(
    { waitForDecision },
    { workspaceId: "w", connectorIds: ["gmail"], queueApproval },
  );
  expect(await execute(wrapper, args)).toContain('"status":"completed"');
  expect(native.prepare).toHaveBeenCalledWith(
    "w",
    "gmail",
    "gmail.send",
    payload,
  );
  expect(waitForDecision).toHaveBeenCalledExactlyOnceWith(
    prepared.action.approval,
  );
  expect(queueApproval).toHaveBeenCalledWith(
    prepared.action.approval,
    "connector-action",
    JSON.stringify({ preview: prepared.preview, payload }),
  );
  expect(native.execute).toHaveBeenCalledWith({
    action: prepared.action,
    approval: expect.objectContaining({
      request: prepared.action.approval,
      decision: "once",
    }),
  });
});

it("denial prevents the native write", async () => {
  const execute = createDesktopToolExecutor(
    { waitForDecision: async () => "denied" },
    { workspaceId: "w", connectorIds: ["gmail"], queueApproval: vi.fn() },
  );
  await expect(execute(wrapper, args)).rejects.toThrow("denied");
  expect(native.execute).not.toHaveBeenCalled();
});

it("revoked agent access prevents execution after approval", async () => {
  let allowed = true;
  const execute = createDesktopToolExecutor(
    {
      waitForDecision: async () => {
        allowed = false;
        return "granted";
      },
    },
    {
      workspaceId: "w",
      connectorAccessCurrent: () => allowed,
      queueApproval: vi.fn(),
    },
  );
  await expect(execute(wrapper, args)).rejects.toThrow("access changed");
  expect(native.execute).not.toHaveBeenCalled();
});

it("account switch during approval fails closed instead of using the newly selected account", async () => {
  let currentAccount = prepared.connectionId;
  const execute = createDesktopToolExecutor(
    {
      waitForDecision: async () => {
        currentAccount = "connection_other";
        return "granted";
      },
    },
    {
      workspaceId: "w",
      connectorIds: ["gmail"],
      connectorAccountCurrent: () => currentAccount,
      queueApproval: vi.fn(),
    },
  );
  await expect(execute(wrapper, args)).rejects.toThrow(
    "connected account changed",
  );
  expect(native.execute).not.toHaveBeenCalled();
});

it("executes against the prepared account when selection is unchanged", async () => {
  const execute = createDesktopToolExecutor(
    { waitForDecision: async () => "granted" },
    {
      workspaceId: "w",
      connectorIds: ["gmail"],
      connectorAccountCurrent: () => prepared.connectionId,
      queueApproval: vi.fn(),
    },
  );
  expect(await execute(wrapper, args)).toContain('"status":"completed"');
  expect(native.execute).toHaveBeenCalledWith({
    action: prepared.action,
    approval: expect.objectContaining({
      request: prepared.action.approval,
      decision: "once",
    }),
  });
});

it("unselected apps and malformed payloads fail before preparation", async () => {
  const execute = createDesktopToolExecutor(
    { waitForDecision: vi.fn() },
    { workspaceId: "w", connectorIds: [] },
  );
  await expect(execute(wrapper, args)).rejects.toThrow("Select or mention");
  expect(native.prepare).not.toHaveBeenCalled();
});

it("Drive uploads bind the saved computer and display the native file details", async () => {
  const payload = {
    artifactId: "artifact-" + "a".repeat(64),
    destinationFolderId: "folder-1",
  };
  const args = JSON.stringify({
    connectorId: "google-drive",
    action: "google-drive.upload-artifact",
    payload,
  });
  const wrapper = buildToolApproval("Claude", "connector-action", args);
  const computer = {
    workspaceId: "w",
    agentId: "a",
    generation: 7,
    ready: true,
    controller: "agent" as const,
  };
  const nativePayload = {
    ...payload,
    filename: "Report.pdf",
    mimeType: "application/pdf",
    sizeBytes: "123",
    sha256: "verified",
  };
  const upload = {
    ...prepared,
    action: {
      ...prepared.action,
      connectorId: "google-drive",
      action: "google-drive.upload-artifact",
      payload: nativePayload,
    },
  };
  native.prepare.mockResolvedValue(upload);
  const queueApproval = vi.fn();
  const execute = createDesktopToolExecutor(
    { waitForDecision: async () => "granted" },
    {
      workspaceId: "w",
      connectorIds: ["google-drive"],
      localComputer: computer,
      queueApproval,
    },
  );
  await execute(wrapper, args);
  expect(native.prepare).toHaveBeenCalledExactlyOnceWith(
    "w",
    "google-drive",
    "google-drive.upload-artifact",
    payload,
    { agentId: "a", generation: 7 },
  );
  expect(queueApproval).toHaveBeenCalledWith(
    upload.action.approval,
    "connector-action",
    JSON.stringify({ preview: upload.preview, payload: nativePayload }),
  );
});

it.each(["generation", "agent", "takeover", "cancel"])(
  "Drive upload fails closed on %s during approval",
  async (change) => {
    const args = JSON.stringify({
      connectorId: "google-drive",
      action: "google-drive.upload-artifact",
      payload: { artifactId: "artifact-a", destinationFolderId: "root" },
    });
    const wrapper = buildToolApproval("Claude", "connector-action", args);
    let computer = {
      workspaceId: "w",
      agentId: "a",
      generation: 7,
      ready: true,
      controller: "agent" as "agent" | "human",
    };
    let cancelled = false;
    const execute = createDesktopToolExecutor(
      {
        waitForDecision: async () => {
          if (change === "generation")
            computer = { ...computer, generation: 8 };
          if (change === "agent") computer = { ...computer, agentId: "other" };
          if (change === "takeover")
            computer = { ...computer, controller: "human" };
          if (change === "cancel") cancelled = true;
          return "granted";
        },
      },
      {
        workspaceId: "w",
        connectorIds: ["google-drive"],
        localComputerCurrent: () => computer,
        shouldCancel: () => cancelled,
        queueApproval: vi.fn(),
      },
    );
    await expect(execute(wrapper, args)).rejects.toThrow(/changed|unavailable/);
    expect(native.execute).not.toHaveBeenCalled();
  },
);

it("Drive uploads require an active saved computer before native preparation", async () => {
  const args = JSON.stringify({
    connectorId: "google-drive",
    action: "google-drive.upload-artifact",
    payload: { artifactId: "artifact-a", destinationFolderId: "root" },
  });
  const execute = createDesktopToolExecutor(
    { waitForDecision: vi.fn() },
    { workspaceId: "w", connectorIds: ["google-drive"] },
  );
  await expect(
    execute(buildToolApproval("Codex", "connector-action", args), args),
  ).rejects.toThrow("saved agent");
  expect(native.prepare).not.toHaveBeenCalled();
});
