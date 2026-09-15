/**
 * Pending OAuth state is first-write immutable: authorize is public, so an
 * observer who copies `state` must not be able to replace the bound desktop
 * redirect before the provider callback. Low-entropy `state` is rejected on
 * every backend (memory, durable-mem, durable RPC).
 */

import { describe, expect, it, vi } from "vitest";

import {
  BROKER_CONTRACT_VERSION,
  BROKER_HANDOFF_TTL_SECONDS,
  BrokerContractError
} from "@fable/connectors";

import { FableBroker } from "./broker.js";
import { fixedClock } from "./clock.js";
import { createSerialInMemoryEphemeralOps } from "./ephemeral-rpc.js";
import {
  createDurableMemoryPendingStore
} from "./durable-stores.js";
import {
  BROKER_AUTHORIZE_STATE_MIN_LENGTH,
  assertAuthorizeState,
  createStores
} from "./stores.js";
import { providerProfile, type BrokerEnv } from "./provider-profiles.js";
import type { BrokerFetch } from "./provider-client.js";

const ENV: BrokerEnv = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret"
};

const VICTIM_REDIRECT = "http://127.0.0.1:43123/callback";
const ATTACKER_REDIRECT = "http://127.0.0.1:9/callback";
const STATE = "victim-state-0000000001";

function githubFetch(): BrokerFetch {
  return vi.fn(async (url: string) => {
    const target = new URL(url);
    const profile = providerProfile("github");
    if (target.href === profile.tokenEndpoint) {
      return new Response(JSON.stringify({
        access_token: "provider-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: profile.scopes.join(" ")
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.href === profile.identityEndpoint) {
      return new Response(JSON.stringify({ id: 1, login: "u", name: "U" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as BrokerFetch;
}

function authorize(state = STATE, redirectUri = VICTIM_REDIRECT) {
  return {
    contractVersion: BROKER_CONTRACT_VERSION,
    provider: "github" as const,
    redirectUri,
    state,
    codeChallenge: "desktop-challenge",
    codeChallengeMethod: "S256" as const
  };
}

describe("pending create-if-absent (redirect hijack)", () => {
  it("memory: second authorize with the same state cannot steal the desktop redirect", async () => {
    const clock = fixedClock(1_000_000);
    const stores = createStores(clock);
    const broker = new FableBroker({
      env: ENV, clock, fetch: githubFetch(), pending: stores.pending, handoff: stores.handoff
    });

    await broker.authorize(authorize(STATE, VICTIM_REDIRECT));
    await expect(broker.authorize(authorize(STATE, ATTACKER_REDIRECT)))
      .rejects.toMatchObject({ error: "invalid-state" });

    expect(stores.pending.peek(STATE)?.redirectUri).toBe(VICTIM_REDIRECT);

    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: STATE }));
    expect(redirect.origin + redirect.pathname).toBe(VICTIM_REDIRECT);
    expect(redirect.toString()).not.toContain(":9/");
    expect(redirect.searchParams.get("handoff")).toBeTruthy();
  });

  it("durable: second authorize with the same state cannot steal the desktop redirect", async () => {
    const clock = fixedClock(2_000_000);
    const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const { ops } = await createSerialInMemoryEphemeralOps(clock, secret);
    const broker = new FableBroker({
      env: ENV, clock, fetch: githubFetch(), publicBaseUrl: "https://b.test/", ephemeralOps: ops
    });

    await broker.authorize(authorize(STATE, VICTIM_REDIRECT));
    await expect(broker.authorize(authorize(STATE, ATTACKER_REDIRECT)))
      .rejects.toMatchObject({ error: "invalid-state" });

    const { redirect } = await broker.callback("github", new URLSearchParams({ code: "c", state: STATE }));
    expect(redirect.origin + redirect.pathname).toBe(VICTIM_REDIRECT);
    expect(redirect.toString()).not.toContain(":9/");
  });

  it("store contract: live overwrite is invalid-state on memory and durable-mem", () => {
    const clock = fixedClock(3_000_000);
    for (const pending of [createStores(clock).pending, createDurableMemoryPendingStore(clock)]) {
      pending.create({
        provider: "github",
        redirectUri: VICTIM_REDIRECT,
        providerRedirectUri: "https://b/cb",
        state: STATE
      });
      try {
        pending.create({
          provider: "github",
          redirectUri: ATTACKER_REDIRECT,
          providerRedirectUri: "https://b/cb",
          state: STATE
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toMatchObject({ error: "invalid-state" });
      }
      expect(pending.peek(STATE)?.redirectUri).toBe(VICTIM_REDIRECT);
    }
  });

  it("expired pending may be created again after TTL", () => {
    const clock = fixedClock(4_000_000);
    const pending = createStores(clock).pending;
    pending.create({
      provider: "github",
      redirectUri: VICTIM_REDIRECT,
      providerRedirectUri: "https://b/cb",
      state: STATE
    });
    clock.advance(BROKER_HANDOFF_TTL_SECONDS * 1000 + 1);
    pending.create({
      provider: "github",
      redirectUri: ATTACKER_REDIRECT,
      providerRedirectUri: "https://b/cb",
      state: STATE
    });
    expect(pending.peek(STATE)?.redirectUri).toBe(ATTACKER_REDIRECT);
  });
});

describe("authorize state entropy", () => {
  it("rejects short and non-unreserved state on memory and durable authorize", async () => {
    const clock = fixedClock(5_000_000);
    const memory = new FableBroker({
      env: ENV, clock, fetch: githubFetch(), pending: createStores(clock).pending
    });
    const { ops } = await createSerialInMemoryEphemeralOps(clock, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const durable = new FableBroker({
      env: ENV, clock, fetch: githubFetch(), publicBaseUrl: "https://b.test/", ephemeralOps: ops
    });

    for (const broker of [memory, durable]) {
      await expect(broker.authorize(authorize("short", VICTIM_REDIRECT)))
        .rejects.toMatchObject({ error: "invalid-state" });
      await expect(broker.authorize(authorize("not valid state!!!!!", VICTIM_REDIRECT)))
        .rejects.toMatchObject({ error: "invalid-state" });
    }
  });

  it("assertAuthorizeState accepts a 128-bit-capable unreserved value", () => {
    expect(() => assertAuthorizeState("a".repeat(BROKER_AUTHORIZE_STATE_MIN_LENGTH - 1))).toThrow(BrokerContractError);
    expect(() => assertAuthorizeState("a".repeat(BROKER_AUTHORIZE_STATE_MIN_LENGTH))).not.toThrow();
    expect(() => assertAuthorizeState("desktop-state-value001")).not.toThrow();
  });
});
