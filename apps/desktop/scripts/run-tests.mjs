#!/usr/bin/env node
import { spawnSync } from 'child_process';

let args = process.argv.slice(2);
// Strip pnpm forwarding and duplicates
args = args.filter(a => a !== '--');
if (args[0] === '--run') args.shift();

const testFile = args.find(a => a.endsWith('.test.ts'));
const vitestArgs = testFile
  ? ['run', '--configLoader', 'runner', testFile, ...args.filter(a => a !== testFile)]
  : ['run', '--configLoader', 'runner', ...args];

const result = spawnSync('pnpm', ['exec', 'vitest', ...vitestArgs], { stdio: 'inherit' });
process.exit(result.status ?? 1);
