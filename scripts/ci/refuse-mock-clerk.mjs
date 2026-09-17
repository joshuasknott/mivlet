import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * CI/deploy counterpart to Convex `auth.config.ts` mock-issuer policy.
 *
 * Local `npx convex dev` (`anonymous:` / `dev:`) and unit tests may set
 * `MIVLET_CLERK_ALLOW_MOCK=1` (legacy `FABLE_CLERK_ALLOW_MOCK`) with
 * `https://mock-clerk.mivlet.local`. Production, preview, staging, and GitHub
 * Actions refuse that pair. Tracked env/workflow/wrangler files must not
 * assign it; local mock belongs in untracked `.env.local` or in-memory tests.
 *
 * Run: `node scripts/ci/refuse-mock-clerk.mjs`
 */

export const MOCK_CLERK_ISSUER = 'https://mock-clerk.mivlet.local';
export const LEGACY_MOCK_CLERK_ISSUER = 'https://mock-clerk.fable.local';

const LOCAL_OR_DEV_DEPLOYMENT = /^(anonymous|dev):/i;
const NON_LOCAL_DEPLOYMENT = /^(prod|preview):/i;
const NON_LOCAL_ENV_LABELS = new Set(['production', 'prod', 'staging', 'preview']);

function readMivletEnvValue(env, suffix) {
  const current = env[`MIVLET_${suffix}`];
  if (current !== undefined) return current;
  return env[`FABLE_${suffix}`];
}

export function isMockClerkIssuer(issuer) {
  const value = issuer?.trim();
  return value === MOCK_CLERK_ISSUER || value === LEGACY_MOCK_CLERK_ISSUER;
}

export function isNonLocalClerkMockEnvironment(env) {
  const deployment = env.CONVEX_DEPLOYMENT?.trim() ?? '';
  if (NON_LOCAL_DEPLOYMENT.test(deployment)) return true;
  if (LOCAL_OR_DEV_DEPLOYMENT.test(deployment)) return false;

  const label = (
    readMivletEnvValue(env, 'CONVEX_ENVIRONMENT') ??
    env.CONVEX_ENV ??
    ''
  )
    .trim()
    .toLowerCase();
  if (NON_LOCAL_ENV_LABELS.has(label)) return true;
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') return true;
  return env.GITHUB_ACTIONS === 'true';
}

export function clerkMockConfigViolation(env) {
  const issuer = readMivletEnvValue(env, 'CLERK_ISSUER');
  const allowMock = readMivletEnvValue(env, 'CLERK_ALLOW_MOCK') === '1';
  if (!allowMock || !isMockClerkIssuer(issuer)) return undefined;
  if (!isNonLocalClerkMockEnvironment(env)) return undefined;
  return 'Convex auth refuses MIVLET_CLERK_ALLOW_MOCK=1 with the mock Clerk issuer on production or non-local deployments.';
}

export function isTrackedClerkConfigPath(path) {
  const base = path.split('/').pop() ?? path;
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return true;
  if (path.startsWith('.github/workflows/') && /\.ya?ml$/i.test(base)) return true;
  return /(?:^|\/)wrangler\.(toml|jsonc?)$/i.test(path);
}

function stripValue(value) {
  const next = value
    .trim()
    .replace(/\s+(?:\/\/|#).*$/, '')
    .replace(/,\s*$/, '');
  if (
    (next.startsWith('"') && next.endsWith('"')) ||
    (next.startsWith("'") && next.endsWith("'"))
  ) {
    return next.slice(1, -1);
  }
  return next;
}

export function parseConfigAssignments(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const match =
      /^(?:export\s+)?(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*[:=]\s*(.*)$/.exec(
        trimmed,
      );
    if (!match) continue;
    env[match[1] ?? match[2]] = stripValue(match[3]);
  }
  return env;
}

export function trackedClerkMockConfigViolation(path, text) {
  if (!isTrackedClerkConfigPath(path)) return undefined;
  const env = parseConfigAssignments(text);
  const issuer = readMivletEnvValue(env, 'CLERK_ISSUER');
  const allowMock = readMivletEnvValue(env, 'CLERK_ALLOW_MOCK') === '1';
  if (!allowMock || !isMockClerkIssuer(issuer)) return undefined;
  return `${path}: tracked deploy/CI config refuses MIVLET_CLERK_ALLOW_MOCK=1 with the mock Clerk issuer; keep that pair in untracked local env or tests.`;
}

export function scanTrackedClerkConfigs(root) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  const violations = [];
  for (const path of output.split('\0').filter(Boolean)) {
    if (!isTrackedClerkConfigPath(path)) continue;
    const violation = trackedClerkMockConfigViolation(
      path,
      readFileSync(join(root, path), 'utf8'),
    );
    if (violation) violations.push(violation);
  }
  return violations;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envViolation = clerkMockConfigViolation(process.env);
  if (envViolation) {
    console.error(envViolation);
    process.exitCode = 1;
  }
  const tracked = scanTrackedClerkConfigs(root);
  if (tracked.length > 0) {
    for (const violation of tracked) console.error(violation);
    process.exitCode = 1;
  } else if (!envViolation) {
    console.log('Mock Clerk issuer is not enabled in production or tracked non-local configs.');
  }
}
