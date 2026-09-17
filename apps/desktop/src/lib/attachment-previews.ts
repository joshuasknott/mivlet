import { getActiveRuntimeDataScope } from "../runtime-scope";
import type { ComposerAttachment } from "./types";

export interface AttachmentPreviewContent { imageDataUrl?: string; text?: string }
// Upload pixels are deliberately transient. Never add these to conversation
// metadata, drafts, model transcripts or a persistent browser cache.
const previews = new Map<string, AttachmentPreviewContent>();
let scope = getActiveRuntimeDataScope();
let size = 0;
const limit = 32 * 1024 * 1024;
function current(workspaceId: string) {
  const active = getActiveRuntimeDataScope();
  if (scope !== active) { previews.clear(); size = 0; scope = active; }
  return active?.workspaceId === workspaceId;
}
const key = (threadId: string, id: string) => JSON.stringify([threadId, id]);
const bytes = (value: AttachmentPreviewContent) => (value.imageDataUrl?.length ?? value.text?.length ?? 0) * 2;

export function retainAttachmentPreviews(workspaceId: string, threadId: string, attachments: readonly ComposerAttachment[]) {
  if (!current(workspaceId)) return;
  for (const attachment of attachments) {
    const value: AttachmentPreviewContent = attachment.imageInput
      ? { imageDataUrl: attachment.imageInput.dataUrl }
      : attachment.transientBytes ? { text: new TextDecoder().decode(attachment.transientBytes.subarray(0, 256 * 1024)) + (attachment.transientBytes.length > 256 * 1024 ? "\n[Preview truncated]" : "") } : {};
    if ((!value.imageDataUrl && value.text === undefined) || bytes(value) > limit) continue;
    if (value.imageDataUrl && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(value.imageDataUrl)) continue;
    const id = key(threadId, attachment.id);
    const previous = previews.get(id);
    if (previous) { size -= bytes(previous); previews.delete(id); }
    while (size + bytes(value) > limit && previews.size) {
      const oldest = previews.keys().next().value!;
      size -= bytes(previews.get(oldest)!); previews.delete(oldest);
    }
    previews.set(id, value); size += bytes(value);
  }
}

export function attachmentPreview(workspaceId: string, threadId: string, id: string) {
  return current(workspaceId) ? previews.get(key(threadId, id)) : undefined;
}
