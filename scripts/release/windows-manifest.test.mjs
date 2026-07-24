import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertReleaseMetadata,
  buildManifest,
  collectWindowsArtifacts,
  renderReleaseNotes
} from "./windows-manifest.mjs";

test("collects one MSI and one NSIS installer with stable hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fable-release-"));
  await mkdir(join(root, "msi"));
  await mkdir(join(root, "nsis"));
  await writeFile(join(root, "msi", "Fable_0.1.0_x64_en-US.msi"), "msi");
  await writeFile(join(root, "nsis", "Fable_0.1.0_x64-setup.exe"), "nsis");
  const artifacts = await collectWindowsArtifacts(root);
  assert.deepEqual(artifacts.map(({ kind, relativePath, signed }) => ({ kind, relativePath, signed })), [
    { kind: "windows-msi", relativePath: "msi/Fable_0.1.0_x64_en-US.msi", signed: false },
    { kind: "windows-nsis", relativePath: "nsis/Fable_0.1.0_x64-setup.exe", signed: false }
  ]);
  assert.match(artifacts[0].sha256, /^[0-9a-f]{64}$/);
});

test("rejects missing and duplicate installer kinds", async () => {
  const missing = await mkdtemp(join(tmpdir(), "fable-release-"));
  await writeFile(join(missing, "Fable.msi"), "msi");
  await assert.rejects(collectWindowsArtifacts(missing), /Missing required windows-nsis/);

  const duplicate = await mkdtemp(join(tmpdir(), "fable-release-"));
  await writeFile(join(duplicate, "Fable.msi"), "msi");
  await writeFile(join(duplicate, "Fable.exe"), "nsis");
  await writeFile(join(duplicate, "Fable-copy.exe"), "nsis");
  await assert.rejects(collectWindowsArtifacts(duplicate), /duplicate installer kinds/);
});

test("manifest is private-only, unsigned, unpublished, and deterministic", () => {
  const input = {
    version: "0.1.0",
    channel: "private",
    commit: "0123456789abcdef",
    createdAt: "2026-07-24T08:00:00.000Z",
    artifacts: [
      { kind: "windows-msi", fileName: "Fable.msi", relativePath: "msi/Fable.msi", bytes: 3, sha256: "a".repeat(64), signed: false },
      { kind: "windows-nsis", fileName: "Fable.exe", relativePath: "nsis/Fable.exe", bytes: 4, sha256: "b".repeat(64), signed: false }
    ]
  };
  const first = buildManifest(input);
  const second = buildManifest(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.signed, false);
  assert.equal(first.publication, "not-published");
  assert.equal(first.updater, "not-published");
  assert.match(renderReleaseNotes(first), /private validation only/);
  assert.throws(() => assertReleaseMetadata({ ...input, channel: "public" }), /not repository-authorized/);
  assert.throws(() => assertReleaseMetadata({ ...input, createdAt: "today" }), /canonical ISO/);
});
