/** Stable cross-runtime digest; all native producers must use this key order. */
export function canonicalHostedTaskJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
    return entry;
  };
  return JSON.stringify(canonical(value));
}
export async function hostedTaskSha256(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalHostedTaskJson(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
}
