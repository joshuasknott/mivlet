import { describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalRecord, ConnectorTokenSet } from "@fable/protocol";
import { ConnectorRuntime, type ConnectorApprovalBoundary } from "../sdk";
import { createGitHubAdapter, GITHUB_CAPABILITIES } from "./github";
import { createVercelAdapter, VERCEL_CAPABILITIES } from "./vercel";
import { createLinearAdapter, LINEAR_CAPABILITIES } from "./linear";

const tokens: ConnectorTokenSet = { accessToken: "test-token", tokenType: "Bearer", scopes: [] };
const common = { clientId: "client", authBaseUrl: "https://auth.example/", redirectUri: "http://127.0.0.1:43123/callback" };

function response(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers }
  });
}

describe("GitHub production adapter", () => {
  it("maps repository reads, pagination, and rate limits", async () => {
    const fetcher = vi.fn(async () => response([{ id: 1, full_name: "acme/fable" }], 200, {
      link: '<https://api.github.com/user/repos?page=2>; rel="next"',
      "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1782600000"
    }));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "repositories.list", input: { limit: 10 } }, tokens);
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/user\/repos.*per_page=10/), expect.objectContaining({ method: "GET" }));
    expect(result).toMatchObject({ nextCursor: "2", rateLimit: { remaining: 42 } });
    expect(result.items[0]).toMatchObject({ id: 1, full_name: "acme/fable" });
  });

  it("maps permissions, expired access, rate limits, network errors, and malformed bodies", async () => {
    for (const [status, code] of [[401, "needs-auth"], [403, "permission-denied"], [429, "rate-limited"]] as const) {
      const adapter = createGitHubAdapter({ ...common, fetch: vi.fn(async () => response({ message: "secret provider detail" }, status)) });
      await expect(adapter.read({ capability: "identity.read", input: {} }, tokens)).rejects.toMatchObject({ code });
    }
    const network = createGitHubAdapter({ ...common, fetch: vi.fn(async () => { throw new Error("socket and token details"); }) });
    await expect(network.read({ capability: "identity.read", input: {} }, tokens)).rejects.toMatchObject({ code: "provider-unavailable" });
    const malformed = createGitHubAdapter({ ...common, fetch: vi.fn(async () => new Response("not-json", { status: 200 })) });
    await expect(malformed.read({ capability: "identity.read", input: {} }, tokens)).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("passes cancellation to provider egress", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("cancelled", "AbortError");
    });
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    await expect(adapter.read({ capability: "identity.read", input: {}, signal: controller.signal }, tokens)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("Vercel production adapter", () => {
  it("never returns environment variable values", async () => {
    const fetcher = vi.fn(async () => response({ envs: [{ id: "env_1", key: "DATABASE_URL", value: "postgres://secret", target: ["production"] }] }));
    const adapter = createVercelAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "environment-metadata.read", input: { project: "fable", teamId: "team_1" } }, tokens);
    expect(fetcher.mock.calls[0][0]).toContain("/v9/projects/fable/env");
    expect(result.items[0]).toEqual({ id: "env_1", key: "DATABASE_URL", target: ["production"] });
    expect(JSON.stringify(result)).not.toContain("postgres://secret");
  });

  it("maps approved deployment operations to the official REST paths", async () => {
    const fetcher = vi.fn(async () => response({ id: "dpl_1", readyState: "READY" }));
    const adapter = createVercelAdapter({ ...common, fetch: fetcher });
    await adapter.write({ capability: "deployments.promote", input: { teamId: "team_1", project: "fable", deploymentId: "dpl_1" }, target: "team_1/fable/dpl_1", preview: "Promote dpl_1 to production", riskLevel: "high" }, tokens);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/v10/projects/fable/promote/dpl_1"), expect.objectContaining({ method: "POST" }));
  });
});

describe("Linear production adapter", () => {
  it("maps searchable issue data and cursor pagination", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain("searchIssues");
      return response({ data: { searchIssues: { nodes: [{ id: "i1", identifier: "FBL-1", title: "Ship" }], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } } } }, 200, { "x-ratelimit-requests-remaining": "4999" });
    });
    const adapter = createLinearAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "issues.search", input: { query: "ship" } }, tokens);
    expect(result).toMatchObject({ nextCursor: "cursor-2", rateLimit: { remaining: 4999 } });
  });

  it("normalizes GraphQL rate limits and malformed responses", async () => {
    const limited = createLinearAdapter({ ...common, fetch: vi.fn(async () => response({ errors: [{ extensions: { code: "RATELIMITED" } }] })) });
    await expect(limited.read({ capability: "teams.read", input: {} }, tokens)).rejects.toMatchObject({ code: "rate-limited", retryable: true });
    const malformed = createLinearAdapter({ ...common, fetch: vi.fn(async () => response({ unexpected: true })) });
    await expect(malformed.read({ capability: "teams.read", input: {} }, tokens)).rejects.toThrow(/malformed/i);
  });
});

describe("developer connector capability and approval registration", () => {
  it("registers complete, unique read/write capability sets", () => {
    for (const capabilities of [GITHUB_CAPABILITIES, VERCEL_CAPABILITIES, LINEAR_CAPABILITIES]) {
      expect(new Set(capabilities.map((capability) => capability.id)).size).toBe(capabilities.length);
      expect(capabilities.some((capability) => capability.kind === "read")).toBe(true);
      expect(capabilities.filter((capability) => capability.kind === "write").every((capability) => capability.consequential)).toBe(true);
    }
  });

  it("cannot execute a GitHub write without a matching explicit approval", async () => {
    const fetcher = vi.fn(async () => response({ id: 1 }));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const boundary: ConnectorApprovalBoundary = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({ ...record, result: "denied", decidedAt: new Date().toISOString() })),
      complete: vi.fn(async () => undefined)
    };
    const runtime = new ConnectorRuntime({ approvals: boundary }); runtime.register(adapter);
    await expect(runtime.write({ connectorId: "github", account: { id: "u1", displayName: "User" }, tokens }, { capability: "issues.create", input: { repository: "acme/fable", title: "Issue" }, target: "acme/fable", preview: "Create issue Issue", riskLevel: "high" })).rejects.toMatchObject({ code: "approval-required" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.FABLE_LIVE_CONNECTOR_TESTS)("opt-in live developer connectors", () => {
  it("requires deliberately supplied credentials", () => {
    expect(process.env.FABLE_LIVE_CONNECTOR_TESTS).toBeTruthy();
    expect(process.env.FABLE_GITHUB_TEST_TOKEN || process.env.FABLE_VERCEL_TEST_TOKEN || process.env.FABLE_LINEAR_TEST_TOKEN).toBeTruthy();
  });
});
