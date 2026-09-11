import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affected } from './affected.mjs';

test('documentation skips expensive jobs', () => {
  assert.deepEqual(affected(['README.md', 'docs/development/verification.md']), { code: false, native: false });
});
test('renderer changes run TypeScript without Windows compilation', () => {
  assert.deepEqual(affected(['apps/desktop/src/App.tsx']), { code: true, native: false });
});
test('native, shared host dependencies, lockfile and workflow changes require Windows', () => {
  for (const path of ['apps/desktop/src-tauri/src/lib.rs', 'apps/desktop/scripts/prepare-cua-driver.mjs', 'packages/agent-host/src/main.ts', 'packages/connectors/src/index.ts', 'packages/protocol/src/index.ts', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'scripts/release/windows-manifest.mjs']) {
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
