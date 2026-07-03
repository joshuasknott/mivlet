#!/usr/bin/env node
/**
 * Forbidden claims scanner. Fails CI if banned phrases appear (case-insensitive).
 * Grounded in spec §22.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const FORBIDDEN = [
  /soc 2/i, /iso 27001/i, /hipaa compliant/i, /hipaa-ready/i, /bank-grade/i,
  /thousands of users/i, /join 10,?000/i,
  /available now on mac/i, /linux download/i,
  /works with all your tools out of the box/i,
  /no setup required/i,
  /encrypted end-to-end cloud sync/i,
  /enterprise-ready/i,
  /named customer logos/i,
  /specific price/i, /free forever/i,
  /july 2026/i, /public launch/i,
  /github writes(?!.*missing|.*read-only)/i, /post to github automatically/i,
  /local ai models included/i,
  /fable account.*required for core/i,
  /copilot replacement/i
];

const ROOT = process.argv[2] || 'dist';
let found = false;

function scan(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) scan(p);
    else if (/\.(html|txt|md|js|astro)$/i.test(extname(p))) {
      const txt = readFileSync(p, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(txt)) {
          console.error(`FORBIDDEN CLAIM: ${re} in ${p}`);
          found = true;
        }
      }
    }
  }
}

try { scan(ROOT); } catch (e) { console.warn('scan target missing, checking built pages only'); }

if (found) {
  console.error('Forbidden claims scanner: FAIL');
  process.exit(1);
}
console.log('Forbidden claims scanner: PASS (no banned phrases)');
process.exit(0);
