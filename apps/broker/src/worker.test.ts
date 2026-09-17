import { describe, expect, it } from "vitest";

import worker, { type Env } from "./worker.js";

const ENV: Env = {
  MIVLET_BROKER_GITHUB_CLIENT_ID: "gh-id",
  MIVLET_BROKER_GITHUB_CLIENT_SECRET: "gh-secret"
};

const VALID_STORE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const DURABLE_BINDING = {
  idFromName: (name: string) => name,
  get: () => ({})
} as unknown as DurableObjectNamespace;

describe("broker Worker entrypoint", () => {
  it("fails closed when the Worker public URL binding is missing", async () => {
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=state-1234567890123456&code_challenge=ch&code_challenge_method=S256"
    ), ENV);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when durable backend selected without encryption key", async () => {
    const envDurable: Env = {
      ...ENV,
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "durable",
      BROKER_PENDING: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_HANDOFF: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_RATELIMIT: DURABLE_BINDING as DurableObjectNamespace<any>
    };
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=s&code_challenge=ch&code_challenge_method=S256"
    ), envDurable);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when durable backend bindings are missing", async () => {
    const envDurable: Env = {
      ...ENV,
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "durable",
      MIVLET_BROKER_STORE_ENCRYPTION_KEY: VALID_STORE_KEY
    };
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=state-1234567890123456&code_challenge=ch&code_challenge_method=S256"
    ), envDurable);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when staging is configured with memory storage", async () => {
    const envStagingMemory: Env = {
      ...ENV,
      MIVLET_BROKER_ENVIRONMENT: "staging",
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "memory"
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envStagingMemory);
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("configuration-required");
    expect(body.message).toBe("Public HTTPS Workers require durable storage.");
  });

  it("fails closed when labeled local with a public HTTPS URL and memory storage", async () => {
    const envLocalPublic: Env = {
      ...ENV,
      MIVLET_BROKER_ENVIRONMENT: "local",
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "memory"
    };
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=state-1234567890123456&code_challenge=ch&code_challenge_method=S256"
    ), envLocalPublic);
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("configuration-required");
    expect(body.message).toBe("Local Workers cannot use a public URL.");
  });

  it("fails closed when the environment is unlabeled and the public URL is public HTTPS", async () => {
    const envUnlabeled: Env = {
      ...ENV,
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "memory"
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envUnlabeled);
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("configuration-required");
    expect(body.message).toBe("Local Workers cannot use a public URL.");
  });

  it("fails closed when labeled local with a public URL even if durable storage is selected", async () => {
    const envLocalDurable: Env = {
      ...ENV,
      MIVLET_BROKER_ENVIRONMENT: "local",
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "durable",
      MIVLET_BROKER_STORE_ENCRYPTION_KEY: VALID_STORE_KEY,
      BROKER_PENDING: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_HANDOFF: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_RATELIMIT: DURABLE_BINDING as DurableObjectNamespace<any>
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envLocalDurable);
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("configuration-required");
    expect(body.message).toBe("Local Workers cannot use a public URL.");
  });

  it("fails closed when a non-local label still uses memory behind public HTTPS", async () => {
    const envPreviewMemory: Env = {
      ...ENV,
      MIVLET_BROKER_ENVIRONMENT: "preview",
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "memory"
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envPreviewMemory);
    expect(response.status).toBe(503);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("configuration-required");
    expect(body.message).toBe("Public HTTPS Workers require durable storage.");
  });

  it("allows local memory storage on a loopback public URL", async () => {
    const envLocalLoopback: Env = {
      ...ENV,
      MIVLET_BROKER_ENVIRONMENT: "local",
      MIVLET_BROKER_PUBLIC_URL: "http://127.0.0.1:8788/",
      MIVLET_BROKER_STORAGE_BACKEND: "memory"
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envLocalLoopback);
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("ok");
  });

  it("allows local memory storage on an HTTPS loopback public URL", async () => {
    const envLocalHttpsLoopback: Env = {
      ...ENV,
      MIVLET_BROKER_ENVIRONMENT: "local",
      MIVLET_BROKER_PUBLIC_URL: "https://127.0.0.1:8788/",
      MIVLET_BROKER_STORAGE_BACKEND: "memory"
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envLocalHttpsLoopback);
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("ok");
  });

  it("fails closed when durable encryption key is malformed", async () => {
    const envDurable: Env = {
      ...ENV,
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "durable",
      MIVLET_BROKER_STORE_ENCRYPTION_KEY: "short",
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
      MIVLET_BROKER_PUBLIC_URL: "http://127.0.0.1:8788/",
      MIVLET_BROKER_STORAGE_BACKEND: "durable",
      MIVLET_BROKER_STORE_ENCRYPTION_KEY: VALID_STORE_KEY,
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
      MIVLET_BROKER_ENVIRONMENT: "staging",
      MIVLET_BROKER_PUBLIC_URL: "https://b.test/",
      MIVLET_BROKER_STORAGE_BACKEND: "durable",
      MIVLET_BROKER_STORE_ENCRYPTION_KEY: VALID_STORE_KEY,
      BROKER_PENDING: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_HANDOFF: DURABLE_BINDING as DurableObjectNamespace<any>,
      BROKER_RATELIMIT: DURABLE_BINDING as DurableObjectNamespace<any>
    };
    const response = await worker.fetch(new Request("https://auth.example.test/healthz"), envStaging);
    expect(response.status).toBe(200);
    expect((await response.json() as { providers: string[] }).providers).toEqual([]);
  });
});
