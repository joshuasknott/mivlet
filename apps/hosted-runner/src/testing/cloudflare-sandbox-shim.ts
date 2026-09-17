/**
 * Node/Vitest stub. Fetch-router tests never instantiate a live Sandbox.
 */
export class Sandbox {}

export function getSandbox(): never {
  throw new Error("sandbox-stub");
}
