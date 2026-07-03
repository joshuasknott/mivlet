import { describe, expect, it } from "vitest";

import worker, { type Env } from "./worker.js";

const ENV: Env = {
  FABLE_BROKER_GITHUB_CLIENT_ID: "gh-id",
  FABLE_BROKER_GITHUB_CLIENT_SECRET: "gh-secret"
};

describe("broker Worker entrypoint", () => {
  it("fails closed when the Worker public URL binding is missing", async () => {
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=s&code_challenge=ch"
    ), ENV);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });

  it("fails closed when durable backend selected without encryption key", async () => {
    const envDurable: Env = { ...ENV, FABLE_BROKER_PUBLIC_URL: 'https://b.test/', FABLE_BROKER_STORAGE_BACKEND: 'durable' };
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
      FABLE_BROKER_STORE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    };
    const response = await worker.fetch(new Request(
      "https://auth.example.test/oauth/github/authorize?redirect_uri=http://127.0.0.1:1/callback&state=state-1234567890123456&code_challenge=ch"
    ), envDurable);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("configuration-required");
  });
});
