import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  CollaborationSnapshot,
  CollaborationWorkItem,
  ProviderAllowance,
} from "@mivlet/protocol";
import { ProviderResetControl } from "./ProviderResetControl";
import { readProviderAllowance } from "../../runtime/domains/provider-usage";
vi.mock("../../runtime/domains/provider-usage", async (original) => ({
  ...(await original<typeof import("../../runtime/domains/provider-usage")>()),
  readProviderAllowance: vi.fn(),
  refreshProviderAllowance: vi.fn(),
}));
const at = new Date().toISOString();
const reset = new Date(Date.now() + 60_000).toISOString();
const measured: ProviderAllowance = {
  providerId: "codex",
  identity: "opaque",
  identityKind: "managed-connection",
  status: "available",
  checkedAt: at,
  observedAt: at,
  windows: [
    { id: "window", label: "Five hour", usedPercent: 100, resetsAt: reset },
  ],
  resetOpportunity: { id: "opportunity", resetsAt: reset },
};
const item: CollaborationWorkItem = {
  id: "work",
  rootId: "work",
  workspaceId: "workspace",
  conversationId: "chat",
  agentId: "agent",
  agentName: "Agent",
  prompt: "Fixture",
  userRequest: "Fixture",
  status: "failed",
  permissionMode: "trusted-scope",
  dependencies: [],
  waitingFor: [],
  prerequisites: [],
  awaitingUser: false,
  generation: 2,
  conversationGeneration: 1,
  contextRevision: 0,
  depth: 0,
  turnCount: 1,
  tokenUsage: 20,
  maxTurns: 6,
  maxTokens: 1000,
  runIds: ["failed-run"],
  modelOptionId: "codex::fixture",
  outputs: [],
  createdAt: at,
  updatedAt: at,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readProviderAllowance).mockResolvedValue(measured);
});
it("requires reconciliation and sends the exact Work generation and reset opportunity", async () => {
  const user = userEvent.setup();
  const choice = {
    opportunityId: "opportunity",
    resetsAt: reset,
    providerId: "codex",
    identity: "opaque",
    generation: 2,
    runId: "failed-run",
    state: "armed" as const,
  };
  const onCommand = vi.fn(
    async () =>
      ({
        work: [{ ...item, resetContinuation: choice }],
      }) as CollaborationSnapshot,
  );
  render(<ProviderResetControl item={item} onCommand={onCommand} />);
  const action = await screen.findByRole("button", {
    name: "Continue once after verified reset",
  });
  expect(action).toBeDisabled();
  await user.click(screen.getByRole("checkbox"));
  await user.click(action);
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({
    action: "arm-provider-reset",
    id: "work",
    expectedGeneration: 2,
    opportunityId: "opportunity",
    reconcile: true,
  });
  expect(
    await screen.findByRole("button", { name: "Cancel reset continuation" }),
  ).toBeInTheDocument();
});
it("does not reuse reconciliation after generation changes or offer a consumed opportunity", async () => {
  const user = userEvent.setup();
  const onCommand = vi.fn();
  const { rerender } = render(
    <ProviderResetControl item={item} onCommand={onCommand} />,
  );
  await screen.findByRole("checkbox");
  await user.click(screen.getByRole("checkbox"));
  await act(async () =>
    rerender(
      <ProviderResetControl
        item={{ ...item, generation: 3 }}
        onCommand={onCommand}
      />,
    ),
  );
  expect(
    await screen.findByRole("button", {
      name: "Continue once after verified reset",
    }),
  ).toBeDisabled();
  await act(async () =>
    rerender(
      <ProviderResetControl
        item={{
          ...item,
          resetContinuation: {
            opportunityId: "opportunity",
            resetsAt: reset,
            providerId: "codex",
            identity: "opaque",
            generation: 2,
            runId: "failed-run",
            state: "consumed",
          },
        }}
        onCommand={onCommand}
      />,
    ),
  );
  expect(
    screen.queryByRole("button", {
      name: "Continue once after verified reset",
    }),
  ).not.toBeInTheDocument();
  expect(onCommand).not.toHaveBeenCalled();
});
