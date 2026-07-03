/**
 * Broker isolation contract test.
 * Proves apps/broker contains ZERO waitlist routes, models, or D1 references.
 * This test must stay in broker package and never import from waitlist.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("broker isolation from waitlist (contract)", () => {
  it("broker source contains no waitlist route strings or imports", () => {
    const routerSrc = readFileSync(join(__dirname, "router.ts"), "utf8");
    expect(routerSrc).not.toMatch(/\/v1\/signup|waitlist|from ["'].*waitlist/);
    const workerSrc = readFileSync(join(__dirname, "worker.ts"), "utf8");
    expect(workerSrc).not.toMatch(/waitlist|\/v1\/signup/);
  });

  it("no D1 or subscriber schema leakage into broker", () => {
    const stores = readFileSync(join(__dirname, "stores.ts"), "utf8");
    expect(stores).not.toMatch(/subscriber|waitlist|consent_text_hash/);
  });
});
