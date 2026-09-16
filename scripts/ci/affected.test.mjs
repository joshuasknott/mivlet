import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affected } from './affected.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const linuxPackageTests = "pnpm --filter '!@mivlet/agent-host' -r --if-present test";
const linuxAffectedTests = 'node --test scripts/ci/affected.test.mjs';
const windowsHostTests = 'pnpm --filter @mivlet/agent-host test';

test('documentation skips expensive jobs', () => {
  assert.deepEqual(affected(['README.md', 'docs/development/verification.md']), { code: false, native: false });
});
test('renderer changes run TypeScript without Windows compilation', () => {
  assert.deepEqual(affected(['apps/desktop/src/App.tsx']), { code: true, native: false });
});
test('native, shared host dependencies, lockfile and workflow changes require Windows', () => {
  for (const path of ['apps/desktop/src-tauri/src/lib.rs', 'apps/desktop/scripts/prepare-cua-driver.mjs', 'packages/agent-host/src/main.ts', 'packages/connectors/src/index.ts', 'packages/protocol/src/index.ts', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'scripts/release/windows-manifest.mjs']) {
    assert.deepEqual(affected([path]), { code: true, native: true }, path);
  }
});
test('unknown code paths fail toward validation', () => {
  assert.equal(affected(['new-package/index.ts']).code, true);
});

test('moving native code into docs still checks the deleted native path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mivlet-ci-paths-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    mkdirSync(join(directory, 'apps/desktop/src-tauri'), { recursive: true });
    mkdirSync(join(directory, 'docs'));
    const original = join(directory, 'apps/desktop/src-tauri/native.rs');
    writeFileSync(original, 'fn main() {}\n');
    git('add', '.');
    git('-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'initial');
    const base = git('rev-parse', 'HEAD');
    renameSync(original, join(directory, 'docs/native.md'));
    git('add', '-A');
    git('-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'move');
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./affected.mjs', import.meta.url))], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: git('rev-parse', 'HEAD'), GITHUB_OUTPUT: '' },
    });
    assert.equal(output, 'code=true\nnative=true\n');
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('mivlet-ci-paths-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('test:pr matches the Linux CI package-test skip gate', () => {
  assert.equal(pkg.scripts['test:pr'], `${linuxPackageTests} && ${linuxAffectedTests}`);
  assert.equal(pkg.scripts['test:ci'], 'pnpm test:pr');
  assert.match(ci, /^\s+- run: pnpm test:pr$/m);
});

test('check:pr matches the Linux TypeScript CI job order', () => {
  assert.equal(pkg.scripts['check:pr'], 'pnpm typecheck && pnpm quality && pnpm test:pr');
  const typecheck = ci.indexOf('pnpm typecheck');
  const quality = ci.indexOf('pnpm quality');
  const testPr = ci.indexOf('pnpm test:pr');
  assert.ok(typecheck >= 0 && typecheck < quality && quality < testPr, ci);
});

test('test:host matches the Windows CI agent-host suite', () => {
  assert.equal(pkg.scripts['test:host'], windowsHostTests);
  assert.match(ci, /^\s+- run: pnpm test:host$/m);
});
