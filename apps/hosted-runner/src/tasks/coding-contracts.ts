import {
  canonicalHostedTaskJson, hostedTaskSha256, hostedTextContentFailure, hostedCodingPath,
  validateHostedCodingScope, HOSTED_CODING_LIMITS as L,
  type HostedCodingRepository, type HostedRepositoryFile, type HostedRepositorySnapshot,
} from "@mivlet/protocol";
import { boundedObject, exactKeys, integer } from "./request-guards";

export const utf8 = new TextEncoder();
export async function byteSha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function hex(value: unknown, length = 64): value is string { return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value); }
export function codingEntries(raw: unknown, total: unknown): HostedRepositoryFile[] {
  if (!Array.isArray(raw) || raw.length > L.files) throw new Error("invalid-coding-manifest");
  const aliases = new Set<string>(); const directories = new Map<string, string>(); let previous = ""; let bytes = 0;
  const files = raw.map(item => {
    const entry = boundedObject(item); exactKeys(entry, ["path", "sizeBytes", "sha256"]);
    const path = hostedCodingPath(entry.path);
    if (path <= previous || aliases.has(path.toLowerCase()) || !hex(entry.sha256)) throw new Error("invalid-coding-manifest");
    previous = path; aliases.add(path.toLowerCase());
    const sizeBytes = integer(entry.sizeBytes, 0, L.fileBytes); bytes += sizeBytes;
    return { path, sizeBytes, sha256: entry.sha256 };
  });
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"); const lower = prefix.toLowerCase();
      if (aliases.has(lower) || directories.has(lower) && directories.get(lower) !== prefix) throw new Error("invalid-coding-manifest");
      directories.set(lower, prefix);
    }
  }
  if (bytes !== integer(total, 0, L.treeBytes)) throw new Error("invalid-coding-manifest");
  return files;
}
async function treeId(files: HostedRepositoryFile[]): Promise<string> {
  const parts: Uint8Array[] = []; let length = 0;
  for (const file of files) {
    const path = utf8.encode(file.path); const size = new Uint8Array(8); new DataView(size.buffer).setBigUint64(0, BigInt(path.length), true);
    const digest = Uint8Array.from(file.sha256.match(/../g)!, pair => parseInt(pair, 16));
    parts.push(size, path, digest); length += 8 + path.length + 32;
  }
  const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return byteSha256(bytes);
}
export async function codingRepository(value: unknown): Promise<HostedCodingRepository> {
  const repo = boundedObject(value); exactKeys(repo, ["snapshot", "scope"]);
  const s = boundedObject(repo.snapshot); exactKeys(s, ["version", "snapshotId", "repositoryId", "branch", "baseCommit", "inputTreeId", "manifestSha256", "files", "writablePaths", "totalBytes"]);
  const files = codingEntries(s.files, s.totalBytes); const scope = validateHostedCodingScope(repo.scope);
  if (s.version !== 1 || !hex(s.snapshotId, 48) || !hex(s.repositoryId, 48) || (!hex(s.baseCommit, 40) && !hex(s.baseCommit))
    || typeof s.branch !== "string" || !s.branch || utf8.encode(s.branch).length > 256 || /[\x00-\x1f\x7f]/.test(s.branch) || hostedTextContentFailure(s.branch)
    || !hex(s.inputTreeId) || !hex(s.manifestSha256) || s.inputTreeId !== await treeId(files)
    || canonicalHostedTaskJson(s.writablePaths) !== canonicalHostedTaskJson(scope.writablePaths)
    || scope.writablePaths.some((path, i) => i > 0 && path <= scope.writablePaths[i - 1])) throw new Error("invalid-coding-manifest");
  // A new writable file may not alias a selected file/directory.
  const all = [...new Set([...files.map(file => file.path), ...scope.writablePaths])].sort();
  codingEntries(all.map(path => ({ path, sizeBytes: 0, sha256: "0".repeat(64) })), 0);
  const { manifestSha256, ...unsigned } = s;
  if (await hostedTaskSha256(unsigned) !== manifestSha256 || hostedTextContentFailure(canonicalHostedTaskJson(scope))) throw new Error("invalid-coding-manifest");
  const snapshot: HostedRepositorySnapshot = { version: 1, snapshotId: s.snapshotId, repositoryId: s.repositoryId, branch: s.branch,
    baseCommit: s.baseCommit, inputTreeId: s.inputTreeId, manifestSha256: s.manifestSha256, files, writablePaths: scope.writablePaths, totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) };
  return { snapshot, scope };
}
export function decodeCodingChunk(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(L.chunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid-coding-chunk");
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (bytes.length > L.chunkBytes || btoa(String.fromCharCode(...bytes)) !== value) throw new Error("invalid-coding-chunk");
  return bytes;
}
export function encodeCodingChunk(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
export function codingSource(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes("\0") || hostedTextContentFailure(text)) throw new Error("coding-source-content-refused");
  return text;
}
