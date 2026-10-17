import {
  hostedTaskSha256, HOSTED_CODING_LIMITS as L,
  type HostedCodingTaskBinding, type HostedCodingChunk, type HostedCodingOutputChunk,
  type HostedCodingOutputRead, type HostedRepositoryFile, type HostedRepositoryOutputManifest,
} from "@mivlet/protocol";
import { byteSha256, codingEntries, codingSource, decodeCodingChunk, encodeCodingChunk, utf8 } from "./coding-contracts";

type Guard = (tx: DurableObjectTransaction) => Promise<HostedCodingTaskBinding>;
interface Candidate { files: HostedRepositoryFile[] }
/** Task-private SQLite chunks. Input is immutable; candidate pointers advance
 * only under the canonical TaskAuthority transaction/generation guard. */
export class CodingFiles {
  constructor(private readonly storage: DurableObjectStorage, private readonly guard: Guard) {}
  private key(kind: "input" | "candidate", sha: string, offset: number): string { return `code:${kind}:${sha}:${offset}`; }

  async putInput(value: HostedCodingChunk): Promise<void> {
    const bytes = decodeCodingChunk(value.dataBase64);
    await this.storage.transaction(async tx => {
      const binding = await this.guard(tx); const snapshot = binding.repository.snapshot;
      const file = snapshot.files.find(file => file.path === value.path);
      if (await tx.get("code:sealed") || value.taskId !== binding.taskId || value.snapshotId !== snapshot.snapshotId || !file
        || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset % L.chunkBytes !== 0
        || value.offset > file.sizeBytes || bytes.length !== Math.min(L.chunkBytes, file.sizeBytes - value.offset)) throw new Error("invalid-coding-chunk");
      const key = this.key("input", file.sha256, value.offset); const prior = await tx.get<Uint8Array>(key);
      if (prior && (prior.length !== bytes.length || prior.some((byte, index) => byte !== bytes[index]))) throw new Error("coding-chunk-conflict");
      await tx.put(key, bytes);
    });
  }
  async sealInput(): Promise<void> {
    const binding = await this.storage.transaction(tx => this.guard(tx));
    for (const file of binding.repository.snapshot.files) {
      const bytes = await this.bytes(file, "input");
      if (await byteSha256(bytes) !== file.sha256) throw new Error("coding-file-hash-mismatch");
      codingSource(bytes);
    }
    await this.storage.transaction(async tx => {
      const current = await this.guard(tx);
      if (await hostedTaskSha256(current) !== await hostedTaskSha256(binding)) throw new Error("task-generation-mismatch");
      if (!await tx.get("code:sealed")) {
        await tx.put("code:candidate", { files: binding.repository.snapshot.files } satisfies Candidate);
        await tx.put("code:sealed", true);
      }
    });
  }
  async manifest(): Promise<HostedRepositoryFile[]> {
    return await this.storage.transaction(async tx => { await this.guard(tx); const candidate = await tx.get<Candidate>("code:candidate"); if (!candidate) throw new Error("coding-input-not-sealed"); return candidate.files; });
  }
  async read(path: string, offset: number, length: number): Promise<{ sha256: string; sizeBytes: number; content: string; end: boolean }> {
    const files = await this.manifest(); const file = files.find(file => file.path === path);
    if (!file || !Number.isSafeInteger(offset) || offset < 0 || offset > file.sizeBytes || !Number.isSafeInteger(length) || length < 1 || length > 16384) throw new Error("coding-read-outside-scope");
    const bytes = await this.currentBytes(file);
    return { sha256: file.sha256, sizeBytes: file.sizeBytes, content: new TextDecoder().decode(bytes.subarray(offset, offset + length)), end: offset + length >= bytes.length };
  }
  async write(path: string, expectedSha256: string | null, content: string | null): Promise<{ sha256: string | null }> {
    const binding = await this.storage.transaction(tx => this.guard(tx));
    if (!binding.repository.scope.writablePaths.includes(path)) throw new Error("coding-write-outside-scope");
    const bytes = content === null ? undefined : utf8.encode(content);
    if (bytes && (bytes.length > L.fileBytes || codingSource(bytes) !== content)) throw new Error("coding-source-content-refused");
    const sha256 = bytes ? await byteSha256(bytes) : null;
    if (bytes && sha256) for (let offset = 0; offset < bytes.length; offset += L.chunkBytes) {
      await this.storage.transaction(async tx => { await this.guard(tx); await tx.put(this.key("candidate", sha256, offset), bytes.subarray(offset, offset + L.chunkBytes)); });
    }
    await this.storage.transaction(async tx => {
      await this.guard(tx); const candidate = await tx.get<Candidate>("code:candidate"); if (!candidate) throw new Error("coding-input-not-sealed");
      const prior = candidate.files.find(file => file.path === path);
      if ((prior?.sha256 ?? null) !== expectedSha256) throw new Error("coding-candidate-changed");
      const files = candidate.files.filter(file => file.path !== path);
      if (bytes && sha256) files.push({ path, sizeBytes: bytes.length, sha256 });
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      codingEntries(files, files.reduce((sum, file) => sum + file.sizeBytes, 0));
      await tx.put("code:candidate", { files } satisfies Candidate);
    });
    return { sha256 };
  }
  async currentBytes(file: HostedRepositoryFile): Promise<Uint8Array> {
    // Candidate chunks are immutable and SHA-named. Unchanged files continue
    // to point to sealed input; no exported local file is implicitly copied.
    const kind = file.sizeBytes === 0 || await this.storage.get(this.key("candidate", file.sha256, 0)) ? "candidate" : "input";
    const bytes = await this.bytes(file, kind);
    if (await byteSha256(bytes) !== file.sha256) throw new Error("coding-file-hash-mismatch");
    return bytes;
  }
  async sealOutput(): Promise<HostedRepositoryOutputManifest> {
    const binding = await this.storage.transaction(tx => this.guard(tx)); const files = await this.manifest();
    for (const file of files) codingSource(await this.currentBytes(file));
    const unsigned = { version: 1 as const, snapshotId: binding.repository.snapshot.snapshotId, inputManifestSha256: binding.repository.snapshot.manifestSha256,
      files, deletedPaths: binding.repository.snapshot.files.filter(input => !files.some(file => file.path === input.path)).map(file => file.path), totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) };
    const output = { ...unsigned, outputManifestSha256: await hostedTaskSha256(unsigned) };
    await this.storage.transaction(async tx => { await this.guard(tx); await tx.put("code:output", output); });
    return output;
  }
  async outputChunk(value: HostedCodingOutputRead): Promise<HostedCodingOutputChunk> {
    const binding = await this.storage.transaction(tx => this.guard(tx));
    const output = await this.storage.get<HostedRepositoryOutputManifest>("code:output");
    const file = output?.files.find(file => file.path === value.path);
    if (value.taskId !== binding.taskId || output?.outputManifestSha256 !== value.outputManifestSha256 || !file
      || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > file.sizeBytes || value.offset % L.chunkBytes !== 0) throw new Error("coding-output-mismatch");
    const bytes = await this.currentBytes(file); const chunk = bytes.subarray(value.offset, value.offset + L.chunkBytes);
    return { ...value, dataBase64: encodeCodingChunk(chunk), end: value.offset + chunk.length === bytes.length };
  }
  private async bytes(file: HostedRepositoryFile, kind: "input" | "candidate"): Promise<Uint8Array> {
    const bytes = new Uint8Array(file.sizeBytes);
    for (let offset = 0; offset < file.sizeBytes; offset += L.chunkBytes) {
      const chunk = await this.storage.get<Uint8Array>(this.key(kind, file.sha256, offset));
      if (!chunk || chunk.length !== Math.min(L.chunkBytes, file.sizeBytes - offset)) throw new Error("coding-file-incomplete");
      bytes.set(chunk, offset);
    }
    return bytes;
  }
}
