import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('marketing a11y structure (static)', () => {
  const files = ['index.html', 'waitlist/index.html', 'connectors/index.html'];

  for (const f of files) {
    it(`has basic landmarks in ${f}`, () => {
      const p = join('dist', f);
      if (!existsSync(p)) return;
      const html = readFileSync(p, 'utf8');
      expect(html).toMatch(/<main|<header|<nav|aria-label|role="main"/i);
    });
  }

  it('skip link exists in layout', () => {
    const p = join('dist', 'index.html');
    if (!existsSync(p)) return;
    const html = readFileSync(p, 'utf8');
    expect(html).toMatch(/skip-link|Skip to main/i);
  });
});
