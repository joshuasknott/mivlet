import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareExecutionAttachments } from "./execution-attachments";
import { restoreRuntimeLocalComputerImageAttachment, stageRuntimeLocalComputerAttachment } from "../runtime/domains/local-computer";
vi.mock("../runtime/domains/local-computer", () => ({ stageRuntimeLocalComputerAttachment: vi.fn(), discardRuntimeLocalComputerAttachmentBatch: vi.fn(), restoreRuntimeLocalComputerImageAttachment: vi.fn() }));
const upload = { id: "upload", name: "budget.xlsx", type: "application/octet-stream", sizeBytes: 3, transientBytes: new Uint8Array([80, 75, 3]) };
const computer = () => ({ prepareForTool: vi.fn(async () => ({ workspaceId: "workspace", agentId: "agent", computerId: "computer", generation: 7 })), refresh: vi.fn(), refreshFiles: vi.fn(async () => null) }) as unknown as Parameters<typeof prepareExecutionAttachments>[1];
beforeEach(() => vi.resetAllMocks());
describe("binary attachment staging", () => {
  it("requires a native receipt before reporting Office access", async () => {
    vi.mocked(stageRuntimeLocalComputerAttachment).mockResolvedValue([{ computerId: "computer", batchId: "batch", attachmentId: "upload", originalName: upload.name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", relativePath: "Attachments/batch/budget.xlsx", sizeBytes: 3, sha256: "hash", stagedAt: "now" }]);
    const result = await prepareExecutionAttachments([upload], computer(), "workspace", "agent", () => true);
    expect(result.attachments[0].workspaceFile?.relativePath).toBe("Attachments/batch/budget.xlsx");
    expect(stageRuntimeLocalComputerAttachment).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: 7, agentId: "agent", attachments: [expect.objectContaining({ contentBase64: "UEsD" })] }));
  });
  it("fails admission when Office bytes cannot be staged instead of claiming knowledge context", async () => {
    vi.mocked(stageRuntimeLocalComputerAttachment).mockRejectedValue(new Error("Invalid Office ZIP"));
    await expect(prepareExecutionAttachments([upload], computer(), "workspace", "agent", () => true)).rejects.toThrow("could not prepare the attached file");
  });
});

describe("durable image attachments", () => {
  const imageInput = { id: "photo", name: "photo.png", mediaType: "image/png" as const, sizeBytes: 3, width: 1, height: 1, dataUrl: "data:image/png;base64,AQID" };
  const attachment = { id: "photo", name: "photo.png", type: "image/png", sizeBytes: 3, imageInput };
  const durableRef = { id: "photo", name: "photo.png", mimeType: "image/png", sizeBytes: 3, availability: "workspace-file" as const, relativePath: "Attachments/upload-batch/photo.png", sha256: "a".repeat(64) };
  const restored = { ...attachment, imageInput: undefined, durableRef };
  const activeComputer = () => {
    const active = computer();
    vi.mocked(active.refresh).mockResolvedValue({ workspaceId: "workspace", agentId: "agent", computerId: "computer", generation: 8 } as never);
    return active;
  };

  it("stages image pixels once and keeps only a native receipt as the durable reference", async () => {
    vi.mocked(stageRuntimeLocalComputerAttachment).mockResolvedValue([{ computerId: "computer", batchId: "batch", attachmentId: "photo", originalName: "photo.png", mimeType: "image/png", relativePath: durableRef.relativePath, sizeBytes: 3, sha256: durableRef.sha256, stagedAt: "now" }]);
    const result = await prepareExecutionAttachments([attachment], computer(), "workspace", "agent", () => true);
    expect(result.attachments[0].workspaceFile?.sha256).toBe(durableRef.sha256);
    expect(stageRuntimeLocalComputerAttachment).toHaveBeenCalledWith(expect.objectContaining({ attachments: [expect.objectContaining({ contentBase64: "AQID" })] }));
    vi.mocked(stageRuntimeLocalComputerAttachment).mockClear();
    await prepareExecutionAttachments(result.attachments, activeComputer(), "workspace", "agent", () => true);
    expect(stageRuntimeLocalComputerAttachment).not.toHaveBeenCalled();
  });

  it("hydrates exact saved image references under the fresh native generation", async () => {
    vi.mocked(restoreRuntimeLocalComputerImageAttachment).mockResolvedValue(imageInput);
    const result = await prepareExecutionAttachments([restored], activeComputer(), "workspace", "agent", () => true);
    expect(result.attachments[0].imageInput).toEqual(imageInput);
    expect(restoreRuntimeLocalComputerImageAttachment).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "agent", expectedGeneration: 8, attachmentId: "photo", name: "photo.png", mimeType: "image/png", relativePath: durableRef.relativePath, sizeBytes: 3, sha256: durableRef.sha256 });
  });

  it("rejects failed, mismatched and late restores instead of silently dropping the image", async () => {
    vi.mocked(restoreRuntimeLocalComputerImageAttachment).mockResolvedValue({ ...imageInput, id: "other" });
    await expect(prepareExecutionAttachments([restored], activeComputer(), "workspace", "agent", () => true)).rejects.toThrow("could not be restored");
    let current = true;
    vi.mocked(restoreRuntimeLocalComputerImageAttachment).mockImplementation(async () => { current = false; return imageInput; });
    await expect(prepareExecutionAttachments([restored], activeComputer(), "workspace", "agent", () => current)).rejects.toThrow("target changed");
    vi.mocked(restoreRuntimeLocalComputerImageAttachment).mockRejectedValue(new Error("The saved image changed"));
    await expect(prepareExecutionAttachments([restored], activeComputer(), "workspace", "agent", () => true)).rejects.toThrow("saved image changed");
  });

  it("does not restore saved pixels from a different agent's computer", async () => {
    await expect(prepareExecutionAttachments([restored], activeComputer(), "workspace", "other-agent", () => true)).rejects.toThrow("unavailable");
    expect(restoreRuntimeLocalComputerImageAttachment).not.toHaveBeenCalled();
  });
});
