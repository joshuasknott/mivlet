import { describe, expect, it } from "vitest";

import worker, { type Env } from "./worker.js";

const ENV: Env = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret"
};

const VALID_STORE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const DURABLE_BINDING = {
  idFromName: (name: string) => name,
  get: () => ({})
} as unknown as DurableObjectNamespace;

describe("broker Worker entrypoint", () => {
  it("fails closed when the Worker public URL binding is missing", async () => {
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=state-1234567890123456&code_challenge=ch"
    ), ENV);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when durable backend selected without encryption key", async () => {
    const envDurable: Env = {
      ...ENV,
      FABLE_BROKER_PUBLIC_URL: "https://b.test/",
      FABLE_BROKER_STORAGE_BACKEND: "durable",
      BROKER_PENDING: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_HANDOFF: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_RATELIMIT: DURABLE_BINDING as DurableObjectNamespace<any>
    };
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=s&code_challenge=ch"
    ), envDurable);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when durable backend bindings are missing", async () => {
    const envDurable: Env = {
      ...ENV,
      FABLE_BROKER_PUBLIC_URL: "https://b.test/",
      FABLE_BROKER_STORAGE_BACKEND: "durable",
      FABLE_BROKER_STORE_ENCRYPTION_KEY: VALID_STORE_KEY
    };
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=state-1234567890123456&code_challenge=ch"
    ), envDurable);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when staging is configured with memory storage", async () => {
    const envStagingMemory: Env = {
      ...ENV,
      FABLE_BROKER_ENVIRONMENT: "staging",
      FABLE_BROKER_PUBLIC_URL: "https://b.test/",
      FABLE_BROKER_STORAGE_BACKEND: "memory"
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envStagingMemory);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when durable encryption key is malformed", async () => {
    const envDurable: Env = {
      ...ENV,
      FABLE_BROKER_PUBLIC_URL: "https://b.test/",
      FABLE_BROKER_STORAGE_BACKEND: "durable",
      FABLE_BROKER_STORE_ENCRYPTION_KEY: "short",
      BROKER_PENDING: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_HANDOFF: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_RATELIMIT: DURABLE_BINDING as DurableObjectNamespace<any>
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envDurable);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when durable Worker public URL is not HTTPS", async () => {
    const envDurable: Env = {
      ...ENV,
      FABLE_BROKER_PUBLIC_URL: "http://127.0.0.1:8788/",
      FABLE_BROKER_STORAGE_BACKEND: "durable",
      FABLE_BROKER_STORE_ENCRYPTION_KEY: VALID_STORE_KEY,
      BROKER_PENDING: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_HANDOFF: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_RATELIMIT: DURABLE_BINDING as DurableObjectNamespace<any>
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envDurable);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("accepts the declared staging durable shape without live provider credentials", async () => {
    const envStaging: Env = {
      FABLE_BROKER_ENVIRONMENT: "staging",
      FABLE_BROKER_PUBLIC_URL: "https://b.test/",
      FABLE_BROKER_STORAGE_BACKEND: "durable",
      FABLE_BROKER_STORE_ENCRYPTION_KEY: VALID_STORE_KEY,
      BROKER_PENDING: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_HANDOFF: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_RATELIMIT: DURABLE_BINDING as DurableObjectNamespace<any>
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envStaging);
    expect(response.status).toBe(200);
    expect((await response.json() as { providers: string[] }).providers).toEqual([]);
  });
});
