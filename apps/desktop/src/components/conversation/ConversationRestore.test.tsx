import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRestore } from "./ConversationRestore";
const mocks = vi.hoisted(() => ({ list: vi.fn(), command: vi.fn(), prepare: vi.fn(), execute: vi.fn() }));
vi.mock("../../runtime/domains/conversation-restore", () => ({ listConversationRestorePoints: mocks.list, conversationRestore: mocks.command, prepareConversationRestore: mocks.prepare, executeConversationRestore: mocks.execute }));
const owner = { workspaceId: "default", conversationId: "chat", agentId: "lead" };
const point = { ...owner, id: "point", label: "Refresh site", createdAt: "2026-10-17T00:00:00Z", targetHeadId: null, checkpoint: { fileCount: 2 } };
const review = { id: "review", point, direction: "restore", checkpoint: { files: [{ path: "app.ts", status: "modified" }], diff: "- old\n+ restored", truncated: false } };
const reload = vi.fn();
beforeEach(() => { vi.resetAllMocks(); reload.mockResolvedValue(undefined); mocks.list.mockResolvedValue({ points: [point], intents: [] }); });
afterEach(cleanup);
async function open() {
  fireEvent.click(screen.getByText("Restore conversation and files"));
  await waitFor(() => expect(mocks.list).toHaveBeenCalled());
}
describe("connected conversation and file recovery", () => {
  it("makes missing legacy restore provenance explicit", async () => {
    mocks.list.mockResolvedValue({ points: [], intents: [] });
    render(<ConversationRestore {...owner} onReloadHistory={reload} />);
    await open();
    expect(await screen.findByText(/No linked recovery points yet/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Preview restore" })).toBeNull();
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it("previews an empty first-turn target and requires exact explicit approval", async () => {
    mocks.command.mockResolvedValue(review);
    mocks.prepare.mockReturnValue({ approval: { confirmationPhrase: "approve restore", consequence: "Restore the reviewed private copy." } });
    mocks.execute.mockResolvedValue({ state: "complete" });
    render(<ConversationRestore {...owner} onReloadHistory={reload} />);
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Preview restore" }));
    expect(await screen.findByText(/Conversation returns to an empty starting point/)).toBeVisible();
    expect(mocks.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review restore approval" }));
    expect(screen.getByRole("button", { name: "Restore files and conversation once" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "approve restore" } });
    fireEvent.click(screen.getByRole("button", { name: "Restore files and conversation once" }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("retains partial outcomes and does not replay the conversation mutation", async () => {
    mocks.list.mockResolvedValue({ points: [point], intents: [{ id: "intent", state: "files-restored", review }] });
    mocks.command.mockRejectedValue(new Error("Conversation changed; reconcile before continuing"));
    render(<ConversationRestore {...owner} onReloadHistory={reload} />);
    await open();
    expect(await screen.findByText(/Files restored. The conversation step/)).toBeVisible();
    expect(mocks.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish conversation restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reconcile/);
    expect(mocks.command).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Review reverting files" })).toBeEnabled();
  });
  it("blocks mutation during active work while allowing history reads", async () => {
    render(<ConversationRestore {...owner} blockedReason="Stop current work before restoring." onReloadHistory={reload} />);
    await open();
    expect(await screen.findByRole("button", { name: "Preview restore" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Stop current work/);
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
