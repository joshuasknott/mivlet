import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandCollaboration } from "./collaboration";
import {
  clearRuntimeAdapterForTest,
  selectRuntimeAdapterForTest,
} from "../adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => {
  mocks.invoke.mockReset();
  selectRuntimeAdapterForTest("native");
});
afterEach(clearRuntimeAdapterForTest);
const command = {
  action: "start-work" as const,
  id: "work-1",
  conversationId: "lead-chat",
  agentId: "test",
  recipientIds: ["test"],
  prompt: "hello",
  discussion: false,
};

it("passes explicit workspace recipients to the native command without changing membership", async () => {
  mocks.invoke.mockResolvedValue({});
  await commandCollaboration("workspace", command);
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
    "collaboration_command",
    { request: { workspaceId: "workspace", command } },
  );
});

it("explains an outdated native runtime without retrying or dropping recipients", async () => {
  mocks.invoke.mockRejectedValue(
    "invalid args `request` for command `collaboration_command`: unknown field `recipientIds`, expected one of `id`, `conversationId`, `agentId`, `prompt`, `discussion`, `attachments`",
  );
  await expect(commandCollaboration("workspace", command)).rejects.toThrow(
    "Restart Mivlet after updating",
  );
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("preserves genuine authorization failures", async () => {
  mocks.invoke.mockRejectedValue(
    "This agent is not a participant in this conversation.",
  );
  await expect(commandCollaboration("workspace", command)).rejects.toThrow(
    "This agent is not a participant",
  );
});
