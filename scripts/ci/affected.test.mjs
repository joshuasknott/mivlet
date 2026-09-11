import { test } from 'node:test';
import assert from 'node:assert/strict';
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
