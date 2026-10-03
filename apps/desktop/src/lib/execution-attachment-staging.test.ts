import { describe, expect, it, vi } from "vitest";
import { prepareExecutionAttachments } from "./execution-attachments";
import { stageRuntimeLocalComputerAttachment } from "../runtime/domains/local-computer";
vi.mock("../runtime/domains/local-computer", () => ({ stageRuntimeLocalComputerAttachment: vi.fn(), discardRuntimeLocalComputerAttachmentBatch: vi.fn() }));
const upload = { id: "upload", name: "budget.xlsx", type: "application/octet-stream", sizeBytes: 3, transientBytes: new Uint8Array([80, 75, 3]) };
const computer = () => ({ prepareForTool: vi.fn(async () => ({ workspaceId: "workspace", agentId: "agent", computerId: "computer", generation: 7 })), refresh: vi.fn(), refreshFiles: vi.fn(async () => null) }) as unknown as Parameters<typeof prepareExecutionAttachments>[1];
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
