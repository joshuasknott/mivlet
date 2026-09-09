import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertReleaseMetadata,
  assertReleaseVersionAlignment,
  buildManifest,
  collectWindowsArtifacts,
  renderReleaseNotes
} from "./windows-manifest.mjs";

test("repository release versions are aligned", async () => {
  assert.equal(await assertReleaseVersionAlignment(), "0.1.0");
});

test("Mivlet installers retain the existing Windows upgrade and data identities", async () => {
  const desktop = new URL("../../apps/desktop/src-tauri/", import.meta.url);
  const config = JSON.parse(await readFile(new URL("tauri.conf.json", desktop), "utf8"));
  assert.equal(config.productName, "Mivlet");
  assert.equal(config.identifier, "com.fable.workspace");
  assert.equal(config.bundle.windows.wix.upgradeCode, "7382634b-7737-5837-ba8c-f1e6cc711f8c");
  const template = await readFile(new URL(config.bundle.windows.nsis.template, desktop), "utf8");
  assert.match(template, /!define LEGACYPRODUCTNAME "Fable"/);
  assert.match(template, /!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$\{LEGACYPRODUCTNAME\}"/);
  assert.match(template, /!define MANUKEY "Software\\fable"/);
  assert.match(template, /!define MANUPRODUCTKEY "\$\{MANUKEY\}\\\$\{LEGACYPRODUCTNAME\}"/);
  assert.match(template, /WriteRegStr SHCTX "\$\{UNINSTKEY\}" "DisplayName" "\$\{PRODUCTNAME\}"/);
  const migration = template.split("!macro MigrateLegacyShortcut DIRECTORY")[1].split("!macroend")[0];
  assert.ok(migration.indexOf("IsShortcutTarget") < migration.indexOf("Rename"));
  assert.match(migration, /\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe/);
});

test("rejects a mismatch across release version sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "fable-versions-"));
  const paths = {
    rootPackagePath: join(root, "package.json"),
    desktopPackagePath: join(root, "desktop-package.json"),
    tauriConfigPath: join(root, "tauri.json"),
    cargoManifestPath: join(root, "Cargo.toml")
  };
  await writeFile(paths.rootPackagePath, JSON.stringify({ version: "0.1.0" }));
  await writeFile(paths.desktopPackagePath, JSON.stringify({ version: "0.1.0" }));
  await writeFile(paths.tauriConfigPath, JSON.stringify({ version: "0.2.0" }));
  await writeFile(paths.cargoManifestPath, '[package]\nname = "fable"\nversion = "0.1.0"\n');
  await assert.rejects(assertReleaseVersionAlignment(paths), /Release versions are not aligned/);
});

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
