import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRoom } from "@mivlet/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { prepareReadableComposerAttachment } from "../../lib/composer-attachments";
import { useScopedComposer } from "../../hooks/useScopedComposer";
import { WorkspaceFileUpload } from "./WorkspaceFileUpload";

vi.mock("../../hooks/useScopedComposer", () => ({ useScopedComposer: vi.fn() }));
vi.mock("../../lib/composer-attachments", () => ({ prepareReadableComposerAttachment: vi.fn() }));
const room = { id: "chat", workspaceId: "workspace", facilitatorId: "agent" } as ConversationRoom;
const runtime = { accountWorkspaceStatus: { activeContextOwner: { internalUserId: "user" } }, importKnowledgeFile: vi.fn() } as unknown as ShellRuntime;
const setAttachments = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useScopedComposer).mockReturnValue({ ready: true, submitting: false, attachments: [], setAttachments } as unknown as ReturnType<typeof useScopedComposer>);
});
describe("Files upload", () => {
  it("adds validated files to the exact conversation draft", async () => {
    vi.mocked(prepareReadableComposerAttachment).mockResolvedValue({ transientBytes: new Uint8Array([65]), sourceId: "source", status: "Attached" });
    const { container } = render(<WorkspaceFileUpload room={room} runtime={runtime} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["A"], "note.txt", { type: "text/plain" })] } });
    expect(await screen.findByRole("status")).toHaveTextContent("Added to the chat draft");
    expect(useScopedComposer).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", threadId: "chat", agentId: "agent" }));
    expect(setAttachments.mock.calls[0][0]([])).toEqual([expect.objectContaining({ name: "note.txt", sourceId: "source" })]);
  });
  it("reports preparation failures without adding a phantom attachment", async () => {
    vi.mocked(prepareReadableComposerAttachment).mockResolvedValue({ status: "Could not read file" });
    const { container } = render(<WorkspaceFileUpload room={room} runtime={runtime} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["A"], "note.txt")] } });
    expect(await screen.findByRole("status")).toHaveTextContent("Could not read file");
    expect(setAttachments).not.toHaveBeenCalled();
  });
});
