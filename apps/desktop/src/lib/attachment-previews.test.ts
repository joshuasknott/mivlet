import { beforeEach, describe, expect, it } from "vitest";
import { attachmentPreview, retainAttachmentPreviews } from "./attachment-previews";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../runtime-scope";

describe("transient attachment previews", () => {
  beforeEach(() => setActiveRuntimeDataScope("workspace"));
  const file = { id: "upload", name: "notes.txt", type: "text/plain", sizeBytes: 5, transientBytes: new TextEncoder().encode("hello") };
  it("retains exact uploaded text only in its workspace and conversation", () => {
    retainAttachmentPreviews("workspace", "thread", [file]);
    expect(attachmentPreview("workspace", "thread", "upload")).toEqual({ text: "hello" });
    expect(attachmentPreview("other", "thread", "upload")).toBeUndefined();
    expect(attachmentPreview("workspace", "other", "upload")).toBeUndefined();
  });
  it("does not restore retained bytes after an account/workspace scope transition", () => {
    retainAttachmentPreviews("workspace", "thread", [file]);
    clearActiveRuntimeDataScope();
    setActiveRuntimeDataScope("workspace");
    expect(attachmentPreview("workspace", "thread", "upload")).toBeUndefined();
  });
  it("bounds text previews and evicts older content at the session limit", () => {
    const large = { ...file, transientBytes: new Uint8Array(300 * 1024).fill(97) };
    retainAttachmentPreviews("workspace", "thread", [large]);
    expect(attachmentPreview("workspace", "thread", "upload")?.text).toHaveLength(256 * 1024 + "\n[Preview truncated]".length);
    retainAttachmentPreviews("workspace", "thread", Array.from({ length: 70 }, (_, index) => ({ ...large, id: `file-${index}` })));
    expect(attachmentPreview("workspace", "thread", "upload")).toBeUndefined();
    expect(attachmentPreview("workspace", "thread", "file-69")).toBeDefined();
  });
});
