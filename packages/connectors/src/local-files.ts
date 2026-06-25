import type { LocalFileImport } from "@praxis/protocol";

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
}

function extensionFor(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
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
  if (!fileName) {
    throw new Error("Choose a file with a valid name.");
  }

  if (!supportedExtensions.has(extensionFor(fileName))) {
    throw new Error("Praxis supports text, Markdown, JSON, CSV, and YAML files.");
  }

  const actualSizeBytes = new TextEncoder().encode(candidate.content).byteLength;
  if (actualSizeBytes !== candidate.sizeBytes) {
    throw new Error("The selected file changed while Praxis was reading it. Choose it again.");
  }

  if (actualSizeBytes === 0) {
    throw new Error("The selected file is empty.");
  }

  if (actualSizeBytes > MAX_LOCAL_FILE_BYTES) {
    throw new Error("Choose a text file smaller than 2 MB.");
  }

  const fingerprint = localFileFingerprint(candidate.content);

  return {
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
}
