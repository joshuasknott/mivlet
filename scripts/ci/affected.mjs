import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function affected(paths) {
  const code = paths.some(path => !(/\.md$/i.test(path) || /^(docs\/|LICENSE$|NOTICE$)/.test(path)));
  const native = paths.some(path => /^(apps\/desktop\/(src-tauri\/|scripts\/(tauri|prepare-cua|collect-cua|native-computer|local-env))|packages\/(agent-host|protocol|connectors)\/|scripts\/(ci|release|audit)\/|\.github\/workflows\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)/.test(path));
  return { code, native };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { BASE_SHA, HEAD_SHA, GITHUB_OUTPUT } = process.env;
  const result = BASE_SHA && HEAD_SHA
    ? affected(execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${BASE_SHA}...${HEAD_SHA}`], { encoding: 'utf8' }).split('\0').filter(Boolean))
    : { code: true, native: true };
  const output = Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join('');
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
