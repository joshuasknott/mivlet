import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_MOCK_CLERK_ISSUER,
  MOCK_CLERK_ISSUER,
  clerkMockConfigViolation,
  isTrackedClerkConfigPath,
  parseConfigAssignments,
  scanTrackedClerkConfigs,
  trackedClerkMockConfigViolation,
} from './refuse-mock-clerk.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const authConfig = readFileSync(join(root, 'apps/desktop/convex/auth.config.ts'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

const mockLocal = {
  MIVLET_CLERK_ISSUER: MOCK_CLERK_ISSUER,
  MIVLET_CLERK_AUDIENCE: 'mivlet-convex-test',
  MIVLET_CLERK_ALLOW_MOCK: '1',
};

test('CI and Convex share the mock Clerk issuer', () => {
  assert.match(authConfig, new RegExp(`MOCK_CLERK_ISSUER = "${MOCK_CLERK_ISSUER}"`));
});

test('CI always runs the mock Clerk deploy guard', () => {
  assert.match(
    ci,
    /^\s+run: node --test scripts\/ci\/refuse-mock-clerk\.test\.mjs && node scripts\/ci\/refuse-mock-clerk\.mjs$/m,
  );
});

test('local and dev Convex names may use ALLOW_MOCK with the mock issuer', () => {
  assert.equal(clerkMockConfigViolation({
    ...mockLocal,
    CONVEX_DEPLOYMENT: 'anonymous:anonymous-mivlet',
    NODE_ENV: 'production',
  }), undefined);
  assert.equal(clerkMockConfigViolation({
    ...mockLocal,
    CONVEX_DEPLOYMENT: 'dev:team-mivlet',
    GITHUB_ACTIONS: 'true',
  }), undefined);
});

test('production, preview, staging, and unlabeled CI refuse the mock pair', () => {
  assert.match(clerkMockConfigViolation({
    ...mockLocal,
    CONVEX_DEPLOYMENT: 'prod:mivlet-prod',
  }), /production or non-local/);
  assert.match(clerkMockConfigViolation({
    ...mockLocal,
    CONVEX_DEPLOYMENT: 'preview:pr-12',
  }), /production or non-local/);
  assert.match(clerkMockConfigViolation({
    ...mockLocal,
    CONVEX_ENV: 'staging',
  }), /production or non-local/);
  assert.match(clerkMockConfigViolation({
    ...mockLocal,
    GITHUB_ACTIONS: 'true',
  }), /production or non-local/);
});

test('legacy FABLE_* mock pair is refused in production and ignored when MIVLET_* is empty', () => {
  assert.match(clerkMockConfigViolation({
    FABLE_CLERK_ISSUER: MOCK_CLERK_ISSUER,
    FABLE_CLERK_ALLOW_MOCK: '1',
    CONVEX_DEPLOYMENT: 'prod:mivlet-prod',
  }), /production or non-local/);
  assert.match(clerkMockConfigViolation({
    MIVLET_CLERK_ISSUER: LEGACY_MOCK_CLERK_ISSUER,
    MIVLET_CLERK_ALLOW_MOCK: '1',
    CONVEX_DEPLOYMENT: 'prod:mivlet-prod',
  }), /production or non-local/);
  assert.equal(clerkMockConfigViolation({
    MIVLET_CLERK_ISSUER: MOCK_CLERK_ISSUER,
    MIVLET_CLERK_ALLOW_MOCK: '',
    FABLE_CLERK_ALLOW_MOCK: '1',
    CONVEX_DEPLOYMENT: 'prod:mivlet-prod',
  }), undefined);
  assert.equal(clerkMockConfigViolation({
    MIVLET_CLERK_ISSUER: 'https://example.clerk.accounts.dev',
    MIVLET_CLERK_ALLOW_MOCK: '1',
    CONVEX_DEPLOYMENT: 'prod:mivlet-prod',
  }), undefined);
});

test('tracked env and workflow files are scanned; tests and docs are not', () => {
  assert.equal(isTrackedClerkConfigPath('apps/desktop/.env.example'), true);
  assert.equal(isTrackedClerkConfigPath('.github/workflows/ci.yml'), true);
  assert.equal(isTrackedClerkConfigPath('apps/broker/wrangler.jsonc'), true);
  assert.equal(isTrackedClerkConfigPath('apps/desktop/convex/auth.config.test.ts'), false);
  assert.equal(isTrackedClerkConfigPath('docs/security/threat-model.md'), false);
});

test('commented mock pair in tracked config is not a violation', () => {
  assert.equal(trackedClerkMockConfigViolation(
    'apps/desktop/.env.example',
    '# MIVLET_CLERK_ALLOW_MOCK=1\n# MIVLET_CLERK_ISSUER=https://mock-clerk.mivlet.local\n',
  ), undefined);
});

test('tracked env assignment of ALLOW_MOCK plus mock issuer is refused', () => {
  const text = parseConfigAssignments(`
MIVLET_CLERK_ISSUER=${MOCK_CLERK_ISSUER}
MIVLET_CLERK_ALLOW_MOCK=1
`);
  assert.equal(text.MIVLET_CLERK_ALLOW_MOCK, '1');
  assert.match(trackedClerkMockConfigViolation('.env.production', `
MIVLET_CLERK_ISSUER=${MOCK_CLERK_ISSUER}
MIVLET_CLERK_ALLOW_MOCK=1
`), /tracked deploy\/CI config refuses/);
  assert.match(trackedClerkMockConfigViolation('apps/broker/wrangler.jsonc', `
  "vars": {
    "MIVLET_CLERK_ISSUER": "${MOCK_CLERK_ISSUER}",
    "MIVLET_CLERK_ALLOW_MOCK": "1"
  }
`), /tracked deploy\/CI config refuses/);
});

test('this repository does not ship the mock pair in tracked configs', () => {
  assert.deepEqual(scanTrackedClerkConfigs(root), []);
});
