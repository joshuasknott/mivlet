import type { LocalFileImport } from "@fable/protocol";

export const MAX_LOCAL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_LOCAL_FILE_PREVIEW_CHARACTERS = 6_000;
export const SUPPORTED_LOCAL_FILE_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "yaml",
  "yml"
] as const;

const supportedExtensions = new Set<string>(SUPPORTED_LOCAL_FILE_EXTENSIONS);

export interface LocalTextFileCandidate {
  name: string;
  content: string;
  sizeBytes: number;
  importedAt?: string;
  /** Optional relative path within the import boundary (preserved as metadata). */
  sourcePath?: string;
  /** Optional content last-modified timestamp (ISO). */
  modifiedAt?: string;
}

/**
 * A bounded validation result for a local file candidate, mirroring the
 * knowledge-package classifier. Used by callers that prefer structured
 * outcomes over thrown errors (e.g. batch/folder imports).
 */
export type LocalFileValidation =
  | { ok: true; mediaType: string }
  | { ok: false; reason: "unsupported-type" | "empty" | "oversized" | "binary" | "malformed"; message: string };

function extensionFor(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

/** MIME type for a supported extension. */
function mimeTypeForExtension(ext: string): string {
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "yaml":
    case "yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

/**
 * Heuristic binary detection (mirrors the knowledge-package classifier): a NUL
 * byte, or a >5% control-character ratio in the first 8KB, is treated as
 * binary. Tab/LF/CR are legitimate text.
 */
function looksBinary(content: string): boolean {
  if (content.length === 0) return false;
  if (content.indexOf("\u0000") >= 0) return true;
  const sampleLen = Math.min(content.length, 8192);
  let control = 0;
  for (let i = 0; i < sampleLen; i++) {
    const code = content.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++;
  }
  return control / sampleLen > 0.05;
}

/**
 * Structured validation of a local file candidate. Returns a tagged result so
 * batch callers can skip a bad file without a try/catch. The checks mirror the
 * knowledge-package `classifyCandidate` (binary, malformed JSON).
 */
export function validateLocalFileCandidate(candidate: LocalTextFileCandidate): LocalFileValidation {
  const fileName = candidate.name.trim().split(/[\\/]/).pop() ?? "";
  if (!fileName) {
    return { ok: false, reason: "unsupported-type", message: "Choose a file with a valid name." };
  }
  const ext = extensionFor(fileName);
  if (!supportedExtensions.has(ext)) {
    return {
      ok: false,
      reason: "unsupported-type",
      message: "Mivlet supports text, Markdown, JSON, CSV, and YAML files."
    };
  }

  const actualSizeBytes = new TextEncoder().encode(candidate.content).byteLength;
  if (actualSizeBytes !== candidate.sizeBytes) {
    return {
      ok: false,
      reason: "unsupported-type",
      message: "The selected file changed while Mivlet was reading it. Choose it again."
    };
  }
  if (actualSizeBytes === 0) {
    return { ok: false, reason: "empty", message: "The selected file is empty." };
  }
  if (actualSizeBytes > MAX_LOCAL_FILE_BYTES) {
    return { ok: false, reason: "oversized", message: "Choose a text file smaller than 2 MB." };
  }
  if (looksBinary(candidate.content)) {
    return {
      ok: false,
      reason: "binary",
      message: "The selected file appears to be binary."
    };
  }
  if (ext === "json") {
    try {
      JSON.parse(candidate.content);
    } catch {
      return { ok: false, reason: "malformed", message: "The selected JSON file is malformed." };
    }
  }
  return { ok: true, mediaType: mimeTypeForExtension(ext) };
}

function fileSlug(fileName: string) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1_024) {
    return `${sizeBytes} B`;
  }

  return `${(sizeBytes / 1_024).toFixed(1)} KB`;
}

export function localFileFingerprint(content: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (const byte of new TextEncoder().encode(content)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}

export function importLocalTextFile(candidate: LocalTextFileCandidate): LocalFileImport {
  const fileName = candidate.name.trim().split(/[\\/]/).pop() ?? "";
  const validation = validateLocalFileCandidate(candidate);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const actualSizeBytes = new TextEncoder().encode(candidate.content).byteLength;
  const fingerprint = localFileFingerprint(candidate.content);

  const imported: LocalFileImport = {
    id: `local-${fileSlug(fileName)}-${fingerprint.slice(0, 8)}`,
    title: fileName,
    kind: "document",
    connectorId: "local-files",
    provenance: `Local file - ${formatFileSize(actualSizeBytes)}`,
    freshness: "Imported now",
    pinned: true,
    trust: "untrusted",
    contentPreview: candidate.content.slice(0, MAX_LOCAL_FILE_PREVIEW_CHARACTERS),
    contentFingerprint: fingerprint,
    sizeBytes: actualSizeBytes,
    importedAt: candidate.importedAt ?? new Date().toISOString(),
    origin: "local-import"
  };
  // Additive metadata (path / media type / modified timestamp) preserved for
  // downstream ingestion and citation provenance.
  if (candidate.sourcePath) imported.sourcePath = candidate.sourcePath;
  if (candidate.modifiedAt) imported.modifiedAt = candidate.modifiedAt;
  imported.mediaType = validation.mediaType;
  return imported;
}
