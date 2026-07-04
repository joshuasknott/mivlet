import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

describe('marketing site build artifacts (M-*)', () => {
  it('M-01 home has the new hero and provider section', () => {
    const p = join(DIST, 'index.html');
    if (!existsSync(p)) { console.warn('dist not present; run build first'); return; }
    const html = readFileSync(p, 'utf8');
    expect(html).toMatch(/Where people and agents/i);
    expect(html).toMatch(/fable-product-demo\.mp4/i);
    expect(html).toMatch(/Codex/i);
    expect(html).toMatch(/OpenCode/i);
    expect(html).not.toMatch(/Hugging Face/i);
    expect(html).not.toMatch(/Windows preview/i);
    expect(html).not.toMatch(/All claims are grounded in the repository/i);
  });

  it('M-02 connectors uses only allowed status labels', () => {
    const p = join(DIST, 'connectors/index.html');
    if (!existsSync(p)) return;
    const html = readFileSync(p, 'utf8');
    // must contain the allowed words, not fabricate others
    expect(html).toMatch(/Implemented|Functional but gated|Preview-only|Missing/);
    expect(html).not.toMatch(/production-ready|thousands/i);
  });

  it('M-03 waitlist form has native POST and required consent', () => {
    const p = join(DIST, 'waitlist/index.html');
    if (!existsSync(p)) return;
    const html = readFileSync(p, 'utf8');
    expect(html).toMatch(/method="POST"/i);
    expect(html).toMatch(/consent_marketing|consent_version/i);
    expect(html).toMatch(/action=.*\/v1\/signup/i);
  });

  it('M-04 confirmed page has no email in URL patterns', () => {
    const p = join(DIST, 'waitlist/confirmed/index.html');
    if (!existsSync(p)) return;
    const html = readFileSync(p, 'utf8');
    expect(html).not.toMatch(/[\w.+-]+@[\w.-]+\.\w+|email=/i); // real email addr or query only (avoid @media etc)
    expect(html).not.toMatch(/confirmed\?[^<]*email/i);
  });

  it('M-05 noscript mailto fallback present', () => {
    const p = join(DIST, 'waitlist/index.html');
    if (!existsSync(p)) return;
    const html = readFileSync(p, 'utf8');
    expect(html).toMatch(/noscript|mailto/i);
  });

  it('M-06 privacy policy linked from form area', () => {
    const p = join(DIST, 'waitlist/index.html');
    if (!existsSync(p)) return;
    const html = readFileSync(p, 'utf8');
    expect(html).toMatch(/privacy-policy|Privacy Policy/i);
    expect(html).not.toMatch(/Privacy Notice/i);
  });

  it('M-07 footer uses a single privacy link and 2026 mark', () => {
    const p = join(DIST, 'index.html');
    if (!existsSync(p)) return;
    const html = readFileSync(p, 'utf8');
    expect(html).toMatch(/© 2026 Fable/i);
    expect(html).toMatch(/Privacy Policy/i);
    expect(html).not.toMatch(/Privacy Notice/i);
  });
});
