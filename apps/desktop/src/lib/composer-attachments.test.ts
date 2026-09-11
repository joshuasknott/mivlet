import { describe, expect, it, vi } from "vitest";
import { MAX_LOCAL_FILE_BYTES } from "@fable/connectors/local-files";
import {
  prepareReadableComposerAttachment,
  projectAttachmentRetryError,
} from "./composer-attachments";

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
    const file = {
      name: "totals.csv",
      size: bytes.byteLength,
      arrayBuffer,
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-1");
    const prepared = await prepareReadableComposerAttachment(
      file,
      importKnowledgeFile,
    );
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(importKnowledgeFile).toHaveBeenCalledWith(
      file,
      "name,value\r\nalpha,6\r\n",
    );
    expect(Array.from(prepared.transientBytes ?? [])).toEqual(
      Array.from(bytes),
    );
  });

  it("reports malformed UTF-8 instead of rejecting or attaching", async () => {
    const bytes = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x0a]);
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const file = {
      name: "broken.txt",
      size: bytes.byteLength,
      arrayBuffer,
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-1");
    const prepared = await prepareReadableComposerAttachment(
      file,
      importKnowledgeFile,
    );
    expect(prepared.status).toContain("UTF-8");
    expect(prepared.transientBytes).toBeUndefined();
    expect(importKnowledgeFile).not.toHaveBeenCalled();
  });

  it("reports a rejected file read instead of rejecting", async () => {
    const arrayBuffer = vi.fn(async () => {
      throw new DOMException("Read failed", "NotReadableError");
    });
    const file = {
      name: "locked.txt",
      size: 4,
      arrayBuffer,
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-1");
    const prepared = await prepareReadableComposerAttachment(
      file,
      importKnowledgeFile,
    );
    expect(prepared.status).toContain("Could not read");
    expect(prepared.transientBytes).toBeUndefined();
    expect(importKnowledgeFile).not.toHaveBeenCalled();
  });

  it("rejects an actual payload that exceeds the limit after reading", async () => {
    const oversized = new Uint8Array(MAX_LOCAL_FILE_BYTES + 1).fill(0x61);
    const arrayBuffer = vi.fn(async () => oversized.buffer);
    const file = {
      name: "declared-ok.txt",
      size: MAX_LOCAL_FILE_BYTES,
      arrayBuffer,
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-1");
    const prepared = await prepareReadableComposerAttachment(
      file,
      importKnowledgeFile,
    );
    expect(prepared.status).toContain("smaller than 2 MB");
    expect(prepared.transientBytes).toBeUndefined();
    expect(importKnowledgeFile).not.toHaveBeenCalled();
  });

  it("reports when the actual bytes differ from the declared size", async () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const file = {
      name: "drifted.txt",
      size: 10,
      arrayBuffer,
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-1");
    const prepared = await prepareReadableComposerAttachment(
      file,
      importKnowledgeFile,
    );
    expect(prepared.status).toContain("changed while Mivlet was reading it");
    expect(prepared.transientBytes).toBeUndefined();
    expect(importKnowledgeFile).not.toHaveBeenCalled();
  });

  it("reports a failed or null knowledge import as a recoverable status", async () => {
    const bytes = new TextEncoder().encode("notes");
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const file = {
      name: "notes.md",
      size: bytes.byteLength,
      arrayBuffer,
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => null);
    const prepared = await prepareReadableComposerAttachment(
      file,
      importKnowledgeFile,
    );
    expect(prepared.status).toBe("Could not read file");
    expect(prepared.transientBytes).toBeUndefined();

    const rejectingImport = vi.fn(async () => {
      throw new Error("native import failed");
    });
    const retried = await prepareReadableComposerAttachment(
      file,
      rejectingImport,
    );
    expect(retried.status).toBe("Could not read file");
    expect(retried.transientBytes).toBeUndefined();
  });

  it("decodes non-ASCII text and keeps the original transient bytes", async () => {
    const text = "café — naïve ✓ ünïcode";
    const bytes = new TextEncoder().encode(text);
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const file = {
      name: "accents.md",
      size: bytes.byteLength,
      arrayBuffer,
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-2");
    const prepared = await prepareReadableComposerAttachment(
      file,
      importKnowledgeFile,
    );
    expect(importKnowledgeFile).toHaveBeenCalledWith(file, text);
    expect(prepared.sourceId).toBe("source-2");
    expect(Array.from(prepared.transientBytes ?? [])).toEqual(
      Array.from(bytes),
    );
  });

  it("recovers on retry after a failed preparation", async () => {
    const badBytes = new Uint8Array([0xff]);
    const badFile = {
      name: "bad.txt",
      size: 1,
      arrayBuffer: vi.fn(async () => badBytes.buffer),
    } as unknown as File;
    const importKnowledgeFile = vi.fn(async () => "source-3");
    const failed = await prepareReadableComposerAttachment(
      badFile,
      importKnowledgeFile,
    );
    expect(failed.status).toContain("UTF-8");
    expect(importKnowledgeFile).not.toHaveBeenCalled();

    const goodBytes = new TextEncoder().encode("retry works");
    const goodFile = {
      name: "good.md",
      size: goodBytes.byteLength,
      arrayBuffer: vi.fn(async () => goodBytes.buffer),
    } as unknown as File;
    const retried = await prepareReadableComposerAttachment(
      goodFile,
      importKnowledgeFile,
    );
    expect(retried.sourceId).toBe("source-3");
    expect(importKnowledgeFile).toHaveBeenCalledWith(goodFile, "retry works");
    expect(Array.from(retried.transientBytes ?? [])).toEqual(
      Array.from(goodBytes),
    );
  });

  it("blocks project retry when the original execution depended on a file", () => {
    expect(
      projectAttachmentRetryError([
        {
          role: "user",
          content: "Summarize this",
          attachments: [
            {
              id: "attachment-1",
              name: "brief.md",
              mimeType: "text/markdown",
              sizeBytes: 12,
              availability: "workspace-file",
              relativePath: "Attachments/upload-a/brief.md",
            },
          ],
        },
      ]),
    ).toContain("Reattach the original files");
  });
});
