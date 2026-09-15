/**
 * Node/Vitest stub. Fetch-router tests never launch Browser Run / Playwright.
 */
export async function connect(): Promise<never> {
  throw new Error("playwright-stub");
}

export async function launch(): Promise<never> {
  throw new Error("playwright-stub");
}
