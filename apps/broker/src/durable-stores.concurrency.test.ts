/**
 * L1 concurrency / race / replay / expiry / mismatch using serial stubs
 * to simulate DO single-threaded atomicity across "isolates".
 */

import { describe, expect, it } from "vitest";

import { fixedClock } from "./clock.js";
import {
  createSerialPendingStoresForTest,
  createSerialHandoffStoresForTest
} from "./durable-stores.js";
import { BROKER_HANDOFF_TTL_SECONDS } from "@fable/connectors";

const clock = fixedClock(100_000);
const TTL = BROKER_HANDOFF_TTL_SECONDS * 1000;

describe("durable consume-once under concurrent races (serial stub)", () => {
  it("pending_consume_single_winner: exactly 1 of N concurrent consumes wins", async () => {
    const { storeA, storeB, stub } = createSerialPendingStoresForTest(clock);
    // put via one
    storeA.create({ provider: "github", redirectUri: "r", providerRedirectUri: "pr", state: "race-state-1234567890" });

    // Simulate cross-isolate: 10 concurrent consumes against shared serial impl
    const attempts = Array.from({ length: 10 }, (_, i) => stub.invoke("consume", "race-state-1234567890"));
    const results = await Promise.all(attempts);
    const wins = results.filter(r => r != null);
    expect(wins.length).toBe(1);
    expect(results.filter(r => r == null).length).toBe(9);
  });

  it("handoff_redeem_single_winner", async () => {
    const { storeA, stub } = createSerialHandoffStoresForTest(clock);
    const ticket = await stub.invoke("issue", { provider: "github", tokens: { accessToken: "t" } as any, account: {} as any, state: "st-r" });

    const attempts = Array.from({ length: 8 }, () => stub.invoke("redeem", ticket, "st-r"));
    const results = await Promise.all(attempts);
    const wins = results.filter(Boolean);
    expect(wins.length).toBe(1);
  });

  it("pending_provider_mismatch_burns (post-consume semantics)", async () => {
    const { storeA, stub } = createSerialPendingStoresForTest(clock);
    await stub.invoke("create", { provider: "github", redirectUri: "r", providerRedirectUri: "pr", state: "mismatch-s-12345678901234567890" });
    // consume as wrong provider would be done in broker layer after consume; here we just ensure consume burns
    const got = await stub.invoke("consume", "mismatch-s-12345678901234567890");
    expect(got?.provider).toBe("github");
    expect(await stub.invoke("consume", "mismatch-s-12345678901234567890")).toBeUndefined();
  });

  it("handoff_state_mismatch_burns_ticket", async () => {
    const { storeA } = createSerialHandoffStoresForTest(clock);
    const t = storeA.issue({ provider: "github", tokens: {} as any, account: {} as any, state: "right" });
    const bad = storeA.redeem(t, "wrong");
    expect(bad).toBeUndefined();
    // burned
    expect(storeA.redeem(t, "right")).toBeUndefined();
  });

  it("expiry rejects and cleans", async () => {
    const c = fixedClock(200_000);
    const { storeA, stub } = createSerialPendingStoresForTest(c);
    await stub.invoke("create", { provider: "github", redirectUri: "r", providerRedirectUri: "pr", state: "e1-12345678901234567890" });
    c.advance(TTL + 100);
    expect(await stub.invoke("consume", "e1-12345678901234567890")).toBeUndefined();
  });
});
