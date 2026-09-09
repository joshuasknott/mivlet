import type { LocalComputerArtifact, LocalComputerArtifactPreview, LocalComputerOpenArtifactRequest } from "@fable/protocol";
import { getRuntimeAdapter, hasNativeRuntimeAdapter } from "../runtime/adapters/select";

const artifactTypes: Readonly<Record<string, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  csv: "text/csv", txt: "text/plain", md: "text/markdown",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
const forbiddenText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** Conversation tool output is untrusted; this is presentation validation only.
 * Native code independently verifies the encrypted receipt and published bytes. */
export function parseComputerArtifact(output: string): LocalComputerArtifact | null {
  if (output.length > 8192) return null;
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const artifact = value as Record<string, unknown>;
    if (artifact.kind !== "computer-artifact" || artifact.version !== 1
      || typeof artifact.id !== "string" || !/^artifact-[a-f0-9]{64}$/.test(artifact.id)
      || typeof artifact.computerId !== "string" || !/^local-[a-f0-9]{24}$/.test(artifact.computerId)
      || typeof artifact.title !== "string" || !artifact.title.trim() || artifact.title.length > 160 || forbiddenText.test(artifact.title)
      || typeof artifact.relativePath !== "string" || artifact.relativePath.length > 512 || forbiddenText.test(artifact.relativePath)
      || artifact.relativePath.includes("\\") || artifact.relativePath.includes(":")
      || artifact.relativePath.split("/").some((part) => !part || part.startsWith(".") || part.trim() !== part || part.endsWith("."))
      || typeof artifact.sizeBytes !== "number" || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || artifact.sizeBytes > 25 * 1024 * 1024
      || typeof artifact.createdAt !== "string" || !Number.isFinite(Date.parse(artifact.createdAt))) return null;
    const extension = artifact.relativePath.split(".").at(-1) ?? "";
    if (!Object.hasOwn(artifactTypes, extension) || artifact.mimeType !== artifactTypes[extension]) return null;
    // Project only known fields, including when old tool messages have extra keys.
    return {
      kind: "computer-artifact", version: 1, id: artifact.id, computerId: artifact.computerId,
      title: artifact.title, relativePath: artifact.relativePath, mimeType: artifactTypes[extension],
      sizeBytes: artifact.sizeBytes, createdAt: artifact.createdAt,
    };
  } catch { return null; }
}

export function canOpenComputerArtifact(): boolean { return hasNativeRuntimeAdapter(); }

export async function openComputerArtifact(request: LocalComputerOpenArtifactRequest): Promise<void> {
  if (!hasNativeRuntimeAdapter()) throw new Error("Open this artifact in the Fable desktop app.");
  if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 0) throw new Error("Refresh the computer before opening this artifact.");
  await getRuntimeAdapter().invoke<void>("local_computer_open_artifact", { request });
}

export function artifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function previewComputerArtifact(request: LocalComputerOpenArtifactRequest): Promise<LocalComputerArtifactPreview> {
  if (!hasNativeRuntimeAdapter()) throw new Error("Preview this file in the Fable desktop app.");
  if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 0) throw new Error("Refresh the computer before previewing this file.");
  return getRuntimeAdapter().invoke<LocalComputerArtifactPreview>("local_computer_preview_artifact", { request });
}
