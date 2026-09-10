import { describe, expect, it, vi } from "vitest";
import { MAX_LOCAL_FILE_BYTES } from "@fable/connectors/local-files";
import { prepareReadableComposerAttachment } from "./composer-attachments";

describe("readable composer attachments", () => {
  it.each([
    ["archive.zip", 4, "Choose a text"],
    ["empty.txt", 0, "non-empty"],
    ["large.md", MAX_LOCAL_FILE_BYTES + 1, "smaller than 2 MB"],
  ])("rejects %s before reading any bytes", async (name, size, message) => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = { name, size, arrayBuffer } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-1");
    await expect(
      prepareReadableComposerAttachment(file, importKnowledgeFile),
    ).resolves.toMatchObject({ status: expect.stringContaining(message) });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(importKnowledgeFile).not.toHaveBeenCalled();
  });

  it("reads exact bytes once and reuses their decoded text for knowledge", async () => {
    const bytes = new TextEncoder().encode("name,value\r\nalpha,6\r\n");
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const file = { name: "totals.csv", size: bytes.byteLength, arrayBuffer } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-1");
    const prepared = await prepareReadableComposerAttachment(file, importKnowledgeFile);
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(importKnowledgeFile).toHaveBeenCalledWith(file, "name,value\r\nalpha,6\r\n");
    expect(Array.from(prepared.transientBytes ?? [])).toEqual(Array.from(bytes));
  });
});
