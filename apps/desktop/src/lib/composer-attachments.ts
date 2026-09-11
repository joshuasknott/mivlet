import {
  MAX_LOCAL_FILE_BYTES,
  SUPPORTED_LOCAL_FILE_EXTENSIONS,
} from "@fable/connectors/local-files";
import type { ExecutionExchange } from "@fable/protocol";

const readableExtensions = new Set<string>(SUPPORTED_LOCAL_FILE_EXTENSIONS);

export interface PreparedReadableComposerAttachment {
  sourceId?: string;
  transientBytes?: Uint8Array;
  status: string;
}

/** Validate before I/O, then read the original upload exactly once. */
export async function prepareReadableComposerAttachment(
  file: File,
  importKnowledgeFile: (
    file: File,
    decodedContent: string,
  ) => Promise<string | null>,
): Promise<PreparedReadableComposerAttachment> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!readableExtensions.has(extension)) {
    return { status: "Choose a text, Markdown, JSON, CSV, or YAML file" };
  }
  if (file.size === 0) return { status: "Choose a non-empty file" };
  if (file.size > MAX_LOCAL_FILE_BYTES) {
    return { status: "Choose a file smaller than 2 MB" };
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { status: "Could not read the file. Choose it again." };
  }
  if (buffer.byteLength > MAX_LOCAL_FILE_BYTES) {
    return { status: "Choose a file smaller than 2 MB" };
  }
  if (buffer.byteLength !== file.size) {
    return {
      status:
        "The selected file changed while Mivlet was reading it. Choose it again.",
    };
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return {
      status: "The selected file is not valid UTF-8 text. Choose it again.",
    };
  }
  if (content.length === 0) return { status: "Choose a non-empty file" };
  let sourceId: string | null;
  try {
    sourceId = await importKnowledgeFile(file, content);
  } catch {
    return { status: "Could not read file" };
  }
  return sourceId
    ? {
        sourceId,
        transientBytes: new Uint8Array(buffer),
        status: "Knowledge context · workspace file when sent",
      }
    : { status: "Could not read file" };
}

export function projectAttachmentRetryError(
  exchanges?: readonly ExecutionExchange[],
) {
  if (exchanges?.some((exchange) => exchange.images?.length)) {
    return "Reattach the original images and send a new project message; image pixels are not stored.";
  }
  if (exchanges?.some((exchange) => exchange.attachments?.length)) {
    return "Reattach the original files and send a new project message; retry does not reuse attachment access.";
  }
  return "";
}
