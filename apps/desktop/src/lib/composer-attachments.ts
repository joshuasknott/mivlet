import {
  MAX_LOCAL_FILE_BYTES,
  SUPPORTED_LOCAL_FILE_EXTENSIONS,
} from "@fable/connectors/local-files";

const readableExtensions = new Set<string>(SUPPORTED_LOCAL_FILE_EXTENSIONS);

export interface PreparedReadableComposerAttachment {
  sourceId?: string;
  transientBytes?: Uint8Array;
  status: string;
}

/** Validate before I/O, then read the original upload exactly once. */
export async function prepareReadableComposerAttachment(
  file: File,
  importKnowledgeFile: (file: File, decodedContent: string) => Promise<string | null>,
): Promise<PreparedReadableComposerAttachment> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!readableExtensions.has(extension)) {
    return { status: "Choose a text, Markdown, JSON, CSV, or YAML file" };
  }
  if (file.size === 0) return { status: "Choose a non-empty file" };
  if (file.size > MAX_LOCAL_FILE_BYTES) {
    return { status: "Choose a file smaller than 2 MB" };
  }
  const buffer = await file.arrayBuffer();
  const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const sourceId = await importKnowledgeFile(file, content);
  return sourceId
    ? {
        sourceId,
        transientBytes: new Uint8Array(buffer),
        status: "Knowledge context · workspace file when sent",
      }
    : { status: "Could not read file" };
}
