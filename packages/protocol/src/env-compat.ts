/**
 * Dual-read `MIVLET_*` then legacy `FABLE_*` environment names.
 *
 * Deprecated: `FABLE_*` aliases remain for one deploy cycle so existing
 * operator secrets keep working. A present empty `MIVLET_*` value does not
 * fall through (fail closed). Values are never logged.
 */

let warnedLegacyAlias = false;

function warnLegacyAlias(): void {
  if (warnedLegacyAlias) return;
  warnedLegacyAlias = true;
  console.warn("mivlet: using deprecated FABLE_* environment aliases; set MIVLET_* instead");
}

export function readMivletEnvValue(
  env: Record<string, string | undefined> | undefined,
  suffix: string
): string | undefined {
  if (!env) return undefined;
  const current = env[`MIVLET_${suffix}`];
  if (current !== undefined) return current;
  const legacy = env[`FABLE_${suffix}`];
  if (legacy !== undefined) warnLegacyAlias();
  return legacy;
}

/**
 * Copy missing `MIVLET_*` keys from legacy `FABLE_*` aliases. Does not
 * overwrite an explicitly set `MIVLET_*` value, including empty strings.
 */
export function withLegacyFableEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("FABLE_") || value === undefined) continue;
    const current = `MIVLET_${key.slice("FABLE_".length)}`;
    if (out[current] === undefined) {
      out[current] = value;
      warnLegacyAlias();
    }
  }
  return out;
}
