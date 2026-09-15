import { describe, expect, it, vi } from "vitest";

import {
  BROKER_PKCE_S256_EXAMPLE
} from "./broker-contract";
import type { Mock } from "vitest";
import type { ConnectorApprovalRecord, ConnectorTokenSet } from "@fable/protocol";
import { ConnectorRuntime } from "../sdk";
import type { ProviderFetch } from "./http";
import {
  mapLinearError,
  normalizeLinearItem,
  shapeLinearSearch
} from "./linear-items";
import { createLinearAdapter, LINEAR_CAPABILITIES } from "./linear";

const tokens: ConnectorTokenSet = { accessToken: "test-token", tokenType: "Bearer", scopes: [] };
const common = { clientId: "client", authBaseUrl: "https://auth.example/", redirectUri: "http://127.0.0.1:43123/callback" };

function response(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

/** Build a fetcher that maps each GraphQL operation root to a canned payload. */
function graphqlFetch(roots: Record<string, unknown>): Mock<ProviderFetch> {
  return vi.fn<ProviderFetch>(async () => response({ data: roots }));
}

/** Read the parsed GraphQL body sent by the adapter. */
async function sentBody(fetcher: Mock<ProviderFetch>) {
  const init = fetcher.mock.calls[0][1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
}

describe("Linear production adapter — read capabilities", () => {
  it("reads workspace identity (viewer)", async () => {
    const fetcher = graphqlFetch({ viewer: { id: "u1", name: "Ada", email: "ada@example.invalid", organization: { id: "org1", name: "Mivlet", urlKey: "fable" } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "identity.read", input: {} }, tokens);
    const body = await sentBody(fetcher);
    expect(body.query).toContain("viewer");
    expect(body.variables).toEqual({});
    expect(result.items[0]).toMatchObject({ id: "u1", name: "Ada", organization: { name: "Mivlet" } });
    expect(result.nextCursor).toBeUndefined();
  });

  it("reads teams with cursor pagination", async () => {
    const fetcher = graphqlFetch({ teams: { nodes: [{ id: "t1", key: "FBL", name: "Mivlet" }], pageInfo: { hasNextPage: true, endCursor: "next" } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: { limit: 5 }, cursor: "cur" }, tokens);
    const body = await sentBody(fetcher);
    expect(body.variables).toMatchObject({ first: 5, after: "cur" });
    expect(result.items[0]).toMatchObject({ id: "t1", key: "FBL" });
    expect(result.nextCursor).toBe("next");
  });

  it("reads projects and omits the cursor when hasNextPage is false", async () => {
    const fetcher = graphqlFetch({ projects: { nodes: [{ id: "p1", name: "Roadmap", state: "started", progress: 0.4 }], pageInfo: { hasNextPage: false, endCursor: null } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "projects.read", input: {} }, tokens);
    expect(result.items[0]).toMatchObject({ id: "p1", name: "Roadmap" });
    expect(result.nextCursor).toBeUndefined();
  });

  it("reads cycles scoped to a team and forwards the teamId variable", async () => {
    const fetcher = graphqlFetch({ cycles: { nodes: [{ id: "c1", number: 3, name: "Cycle 3", progress: 0.1 }], pageInfo: { hasNextPage: false, endCursor: null } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "cycles.read", input: { teamId: "team-uuid" } }, tokens);
    const body = await sentBody(fetcher);
    expect(body.variables).toMatchObject({ teamId: "team-uuid" });
    expect(body.query).toContain("cycles");
    expect(result.items[0]).toMatchObject({ id: "c1", number: 3 });
  });

  it("lists issues and resolves the next cursor", async () => {
    const fetcher = graphqlFetch({ issues: { nodes: [{ id: "i1", identifier: "FBL-1", title: "Ship", priority: 1, url: "https://linear.app/issue/FBL-1" }], pageInfo: { hasNextPage: true, endCursor: "page-2" } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "issues.read", input: {} }, tokens);
    expect(result.items[0]).toMatchObject({ id: "i1", identifier: "FBL-1" });
    expect(result.nextCursor).toBe("page-2");
  });

  it("reads a single issue by issueId (non-connection root)", async () => {
    const fetcher = graphqlFetch({ issue: { id: "i9", identifier: "FBL-9", title: "Detail", state: { id: "s1", name: "In Progress", type: "started" }, team: { id: "t1", key: "FBL", name: "Mivlet" } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "issues.read", input: { issueId: "uuid-9" } }, tokens);
    const body = await sentBody(fetcher);
    expect(body.variables).toEqual({ id: "uuid-9" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "i9", identifier: "FBL-9", state: { name: "In Progress" } });
    expect(result.nextCursor).toBeUndefined();
  });

  it("searches issues with the term variable and paginates", async () => {
    const fetcher = graphqlFetch({ searchIssues: { nodes: [{ id: "i2", identifier: "FBL-2", title: "ship it", url: "https://linear.app/issue/FBL-2" }], pageInfo: { hasNextPage: true, endCursor: "search-2" } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "issues.search", input: { query: "ship" } }, tokens);
    const body = await sentBody(fetcher);
    expect(body.variables).toMatchObject({ query: "ship" });
    expect(result.items[0]).toMatchObject({ id: "i2", identifier: "FBL-2" });
    expect(result.nextCursor).toBe("search-2");
  });

  it("reads issue comments and paginates the nested comment connection", async () => {
    const fetcher = graphqlFetch({ issue: { comments: { nodes: [{ id: "cm1", body: "looks good", user: { id: "u1", name: "Ada" } }, { id: "cm2", body: "ship it", user: { id: "u2", name: "Bo" } }], pageInfo: { hasNextPage: true, endCursor: "comments-2" } } } });
    const result = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "comments.read", input: { issueId: "uuid-1" } }, tokens);
    const body = await sentBody(fetcher);
    expect(body.variables).toMatchObject({ id: "uuid-1", first: expect.any(Number) });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ id: "cm1", body: "looks good" });
    expect(result.items[1]).toMatchObject({ id: "cm2", body: "ship it" });
    expect(result.nextCursor).toBe("comments-2");
  });

  it("reads labels and users connections", async () => {
    const labels = graphqlFetch({ issueLabels: { nodes: [{ id: "lb1", name: "bug", color: "#e11" }], pageInfo: { hasNextPage: false, endCursor: null } } });
    const labelResult = await createLinearAdapter({ ...common, fetch: labels }).read({ capability: "labels.read", input: {} }, tokens);
    expect(labelResult.items[0]).toMatchObject({ id: "lb1", name: "bug" });

    const users = graphqlFetch({ users: { nodes: [{ id: "u1", name: "Ada", displayName: "Ada Lovelace", active: true }], pageInfo: { hasNextPage: false, endCursor: null } } });
    const userResult = await createLinearAdapter({ ...common, fetch: users }).read({ capability: "users.read", input: {} }, tokens);
    expect(userResult.items[0]).toMatchObject({ id: "u1", name: "Ada", active: true });
  });

  it("clamps the page size into the supported window", async () => {
    const fetcher = graphqlFetch({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "issues.read", input: { limit: 9999 } }, tokens);
    const body = await sentBody(fetcher);
    expect(body.variables).toMatchObject({ first: 50 });
  });
});

describe("Linear production adapter — required arguments", () => {
  it("rejects cycles.read without a teamId before any network call", async () => {
    const fetcher = vi.fn(async () => response({ data: {} }));
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "cycles.read", input: {} }, tokens)).rejects.toThrow(/teamId/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects comments.read without an issueId before any network call", async () => {
    const fetcher = vi.fn(async () => response({ data: {} }));
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "comments.read", input: {} }, tokens)).rejects.toThrow(/issueId/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects issues.search without a query before any network call", async () => {
    const fetcher = vi.fn(async () => response({ data: {} }));
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "issues.search", input: {} }, tokens)).rejects.toThrow(/query/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws on an unsupported read capability", async () => {
    await expect(createLinearAdapter({ ...common, fetch: vi.fn() }).read({ capability: "linear.bogus", input: {} } as never, tokens)).rejects.toThrow(/Unsupported Linear read capability/);
  });
});

describe("Linear production adapter — error normalization", () => {
  it.each([
    ["RATELIMITED", "rate-limited", true],
    ["AUTHENTICATION_ERROR", "expired-auth", false],
    ["FORBIDDEN", "permission-denied", false],
    ["BAD_REQUEST", "invalid-request", false]
  ] as const)("maps GraphQL extension code %s to %s", async (code, expected, retryable) => {
    const fetcher = vi.fn(async () => response({ errors: [{ message: "provider detail", extensions: { code } }] }));
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens)).rejects.toMatchObject({ code: expected, retryable });
  });

  it.each([
    [401, "expired-auth"],
    [403, "permission-denied"],
    [429, "rate-limited"],
    [500, "provider-unavailable"]
  ] as const)("maps HTTP %i status to a normalized connector code", async (status, code) => {
    const fetcher = vi.fn(async () => response({ message: "secret detail" }, status));
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens)).rejects.toMatchObject({ code });
  });

  it("rejects a malformed GraphQL response missing data", async () => {
    const fetcher = vi.fn(async () => response({ unexpected: true }));
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens)).rejects.toThrow(/malformed/i);
  });

  it("rejects malformed JSON bodies as provider-unavailable", async () => {
    const fetcher = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens)).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("treats network failures as provider-unavailable without leaking socket detail", async () => {
    const fetcher = vi.fn(async () => { throw new Error("ECONNRESET on socket secret-host"); });
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens)).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("ensures user-facing error messages never echo provider secret detail", async () => {
    const fetcher = vi.fn(async () => response({ message: "token linear-secret-xyz was revoked" }, 400));
    const error = await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens).catch((value) => value);
    expect(error.message).not.toContain("linear-secret-xyz");
  });
});

describe("Linear production adapter — cancellation and redaction", () => {
  it("passes cancellation to provider egress and rethrows AbortError", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {}, signal: controller.signal }, tokens)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the bearer token in the Authorization header, never in the URL", async () => {
    const fetcher = graphqlFetch({ teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).not.toContain("test-token");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-token" });
  });

  it("posts GraphQL to the /graphql path", async () => {
    const fetcher = graphqlFetch({ teams: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await createLinearAdapter({ ...common, fetch: fetcher }).read({ capability: "teams.read", input: {} }, tokens);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("/graphql");
    expect(init?.method).toBe("POST");
  });
});

describe("Linear production adapter — capability registration", () => {
  it("advertises a complete, unique, read/write capability set", () => {
    const ids = LINEAR_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LINEAR_CAPABILITIES.some((capability) => capability.kind === "read")).toBe(true);
    expect(LINEAR_CAPABILITIES.filter((capability) => capability.kind === "write").every((capability) => capability.consequential)).toBe(true);
    // The full read scope the objective requires.
    for (const id of ["identity.read", "teams.read", "projects.read", "cycles.read", "issues.read", "issues.search", "comments.read", "labels.read", "users.read"]) {
      expect(ids).toContain(id);
    }
  });
});

describe("Linear production adapter — broker auth contract", () => {
  it("routes authorize through the broker oauth path with PKCE", async () => {
    const start = await createLinearAdapter({ ...common, fetch: vi.fn() }).startAuth({ redirectUri: common.redirectUri, state: "state-1", codeChallenge: BROKER_PKCE_S256_EXAMPLE.challenge });
    const authorize = new URL(start.authorizationUrl);
    expect(authorize.pathname).toBe("/oauth/linear/authorize");
    expect(authorize.searchParams.get("code_challenge")).toBe(BROKER_PKCE_S256_EXAMPLE.challenge);
    expect(authorize.searchParams.get("scope")).toBe("read write issues:create comments:create");
    expect(start.state).toBe("state-1");
  });

  it("redeems, refreshes, and revokes through the versioned broker contract", async () => {
    const fetcher = vi.fn<ProviderFetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      expect(body.contractVersion).toBe(1);
      expect(body.provider).toBe("linear");
      if (path.endsWith("/handoff")) return response({ contractVersion: 1, tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", tokenType: "Bearer", scopes: ["read"] }, account: { id: "lin-uid", displayName: "Linear User" } });
      if (path.endsWith("/refresh")) return response({ contractVersion: 1, tokens: { accessToken: "synthetic-access-2", tokenType: "Bearer", scopes: ["read"] } });
      return response({ contractVersion: 1, revoked: true });
    });
    const adapter = createLinearAdapter({ ...common, fetch: fetcher });
    const auth = await adapter.completeAuth({ callbackUrl: `${common.redirectUri}?handoff=t&state=s`, expectedState: "s", codeVerifier: BROKER_PKCE_S256_EXAMPLE.verifier });
    expect(auth).toMatchObject({ tokens: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }, account: { id: "lin-uid" } });
    await expect(adapter.refresh(auth.tokens)).resolves.toMatchObject({ accessToken: "synthetic-access-2", refreshToken: "synthetic-refresh" });
    await expect(adapter.revoke(auth.tokens)).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/oauth/linear/handoff", "/oauth/linear/refresh", "/oauth/linear/revoke"
    ]);
  });

  it("fails closed on a state mismatch before contacting the broker", async () => {
    const fetcher = vi.fn(async () => response({ contractVersion: 1, tokens: { accessToken: "a", tokenType: "Bearer", scopes: [] }, account: { id: "lin-uid", displayName: "Linear User" } }));
    const adapter = createLinearAdapter({ ...common, fetch: fetcher });
    await expect(adapter.completeAuth({ callbackUrl: `${common.redirectUri}?handoff=t&state=attacker`, expectedState: "expected", codeVerifier: BROKER_PKCE_S256_EXAMPLE.verifier })).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces missing broker configuration and expired refresh tokens", async () => {
    const unconfigured = createLinearAdapter({ ...common, fetch: vi.fn(async () => response({ error: "configuration-required", message: "Linear is not configured on this broker.", retryable: false }, 503)) });
    await expect(unconfigured.completeAuth({ callbackUrl: `${common.redirectUri}?handoff=t&state=s`, expectedState: "s", codeVerifier: BROKER_PKCE_S256_EXAMPLE.verifier })).rejects.toMatchObject({ code: "configuration-required", message: "Linear is not configured on this broker." });

    const expired = createLinearAdapter({ ...common, fetch: vi.fn(async () => response({ error: "needs-auth", message: "Refresh token was rejected.", retryable: false }, 401)) });
    await expect(expired.refresh({ ...tokens, refreshToken: "synthetic-refresh" })).rejects.toMatchObject({ code: "expired-auth", message: "Refresh token was rejected." });
  });
});

describe("Linear production adapter — writes are approval-gated", () => {
  it("cannot execute an issue create without a matching explicit approval", async () => {
    const fetcher = vi.fn(async () => response({ data: { issueCreate: { success: true, issue: { id: "i1", identifier: "FBL-1" } } } }));
    const adapter = createLinearAdapter({ ...common, fetch: fetcher });
    const boundary = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({ ...record, result: "denied" as const, decidedAt: new Date().toISOString() })),
      complete: vi.fn(async () => undefined)
    };
    const runtime = new ConnectorRuntime({ approvals: boundary });
    runtime.register(adapter);
    await expect(runtime.write({ connectorId: "linear", account: { id: "lin-uid", displayName: "Linear User" }, tokens }, { capability: "issues.create", input: { teamId: "t1", title: "New issue" }, target: "FBL / New issue", preview: "Create issue New issue", riskLevel: "high" })).rejects.toMatchObject({ code: "approval-required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("executes an approved issue create and surfaces a non-success mutation", async () => {
    const fetcher = vi.fn<ProviderFetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain("issueCreate");
      return response({ data: { issueCreate: { success: true, issue: { id: "i1", identifier: "FBL-1", title: "New issue", url: "https://linear.app/issue/FBL-1" } } } });
    });
    const adapter = createLinearAdapter({ ...common, fetch: fetcher });
    const boundary = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({ ...record, result: "approved" as const, decidedAt: new Date().toISOString() })),
      complete: vi.fn(async () => undefined)
    };
    const runtime = new ConnectorRuntime({ approvals: boundary });
    runtime.register(adapter);
    const result = await runtime.write({ connectorId: "linear", account: { id: "lin-uid", displayName: "Linear User" }, tokens }, { capability: "issues.create", input: { teamId: "t1", title: "New issue" }, target: "FBL / New issue", preview: "Create issue New issue", riskLevel: "high", idempotencyKey: "k1" });
    expect(result).toMatchObject({ success: true, issue: { identifier: "FBL-1" } });

    // A mutation that the provider rejects (success: false) throws.
    const failed = createLinearAdapter({ ...common, fetch: vi.fn(async () => response({ data: { issueCreate: { success: false } } })) });
    await expect(failed.write({ capability: "issues.create", input: { teamId: "t1", title: "x" }, target: "FBL / x", preview: "Create issue x", riskLevel: "high" }, tokens)).rejects.toThrow(/did not succeed/);
  });

  it("requires issueId/body for the comment mutation", async () => {
    const adapter = createLinearAdapter({ ...common, fetch: vi.fn() });
    await expect(adapter.write({ capability: "comments.create", input: {}, target: "t", preview: "p", riskLevel: "high" } as never, tokens)).rejects.toThrow(/issueId/);
  });
});

describe("Linear user-safe result shapes", () => {
  it("normalizes a Linear issue into a ConnectorSearchItem", () => {
    const item = normalizeLinearItem({ id: "uuid-12", kind: "issue", identifier: "FBL-12", title: "Ship connectors", workspace: "Mivlet", team: "FBL", state: "In Progress", url: "https://linear.app/issue/FBL-12", description: "Implement adapters", updatedAt: "2026-06-27T10:00:00Z" });
    expect(item).toMatchObject({
      id: "uuid-12", connectorId: "linear", kind: "issue",
      title: "FBL-12 · Ship connectors",
      provenance: "Linear · Mivlet",
      freshness: "2026-06-27T10:00:00Z",
      trust: "untrusted",
      url: "https://linear.app/issue/FBL-12",
      contentPreview: "Implement adapters"
    });
    expect(item.providerMetadata).toMatchObject({ workspace: "Mivlet", team: "FBL", state: "In Progress" });
  });

  it("normalizes a Linear project without optional fields", () => {
    const item = normalizeLinearItem({ id: "p1", kind: "project", identifier: "", title: "Roadmap", workspace: "Mivlet" });
    expect(item.title).toBe("Roadmap");
    expect(item.summary).toBe("project in Mivlet");
    expect(item.freshness).toBe("Provider freshness unavailable");
    expect(item.providerMetadata).toEqual({ workspace: "Mivlet" });
  });

  it("shapes a search request with a normalized limit", () => {
    const request = shapeLinearSearch("ship it", 100);
    expect(request.connectorId).toBe("linear");
    expect(request.query).toBe("ship it");
    expect(request.limit).toBeLessThanOrEqual(50);
  });

  it("classifies provider errors into safe connector codes", () => {
    // The shared classifier maps a bare 401 to needs-auth (only an explicit
    // "expired" code/token surfaces expired-auth), consistent with the other
    // providers that use classifyConnectorError.
    expect(mapLinearError({ status: 401 }).code).toBe("needs-auth");
    expect(mapLinearError({ status: 401, code: "expired_token" }).code).toBe("expired-auth");
    expect(mapLinearError({ status: 429 }).code).toBe("rate-limited");
    expect(mapLinearError({ code: "not_found" }).code).toBe("not-found");
  });
});

describe.runIf(Boolean(process.env.FABLE_LIVE_CONNECTOR_TESTS))("live Linear connector", () => {
  it.skip("runs only when deliberately supplied credentials are handled by the native keyring boundary", () => undefined);
});
