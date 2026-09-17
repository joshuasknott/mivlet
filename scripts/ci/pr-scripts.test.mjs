import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

test('test:pr excludes the Windows agent-host package the way Linux PR CI does', () => {
  assert.match(pkg.scripts['test:pr'], /--filter "!@mivlet\/agent-host"/);
  assert.equal(pkg.scripts['test:ci'], 'pnpm test:pr');
});

test('Linux TypeScript job runs test:pr; Windows host job runs test:host', () => {
  assert.match(ci, /^\s+- run: pnpm test:pr$/m);
  assert.match(ci, /^\s+- run: pnpm test:host$/m);
  assert.doesNotMatch(ci, /^\s+- run: pnpm test$/m);
  assert.equal(pkg.scripts['test:host'], 'pnpm --filter @mivlet/agent-host test');
  assert.equal(pkg.scripts['check:pr'], 'pnpm typecheck && pnpm quality && pnpm test:pr');
});

test('lint:security is the ESLint security subset; lint stays the umbrella', () => {
  assert.equal(pkg.scripts['lint:security'], 'eslint apps packages scripts --max-warnings=0');
  assert.equal(pkg.scripts['lint'], 'pnpm lint:security && node scripts/quality/check-explicit-any.mjs');
  assert.doesNotMatch(pkg.scripts['lint:security'], /audit/);
});
