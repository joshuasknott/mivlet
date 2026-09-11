import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ConnectorTokenSet } from "@fable/protocol";
import type { ConnectorWriteRequest } from "../sdk";
import type { ProviderFetch } from "./http";
import { createLinearAdapter } from "./linear";

const tokens: ConnectorTokenSet = {
  accessToken: "test-token",
  tokenType: "Bearer",
  scopes: [],
};
const common = {
  clientId: "client",
  authBaseUrl: "https://auth.example/",
  redirectUri: "http://127.0.0.1:43123/callback",
};

function response(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Build a fetcher that returns a raw GraphQL envelope (data + optional errors). */
function graphqlFetch(body: Record<string, unknown>): Mock<ProviderFetch> {
  return vi.fn<ProviderFetch>(async () => response(body));
}

/** Build a fetcher that maps each GraphQL operation root to a canned payload. */
function dataFetch(roots: Record<string, unknown>): Mock<ProviderFetch> {
  return graphqlFetch({ data: roots });
}

/** Read the parsed GraphQL body sent by the adapter. */
async function sentBody(fetcher: Mock<ProviderFetch>) {
  const init = fetcher.mock.calls[0][1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

const write = (
  capability: ConnectorWriteRequest["capability"],
  input: Record<string, unknown>,
  signal?: AbortSignal,
): ConnectorWriteRequest => ({
  capability,
  input,
  target: "FBL / New issue",
  preview: "Preview issue",
  riskLevel: "high",
  ...(signal ? { signal } : {}),
});

describe("Linear GraphQL — partial data and errors never claim completion", () => {
  it("fails closed on a read with partial data plus errors", async () => {
    const fetcher = graphqlFetch({
      data: {
        teams: {
          nodes: [{ id: "t1", key: "FBL" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      errors: [
        {
          message: "workspace secret detail",
          path: ["teams"],
          extensions: { code: "FORBIDDEN" },
        },
      ],
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "permission-denied", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a mutation that reports errors alongside a success field", async () => {
    const fetcher = graphqlFetch({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i1", identifier: "FBL-1" },
        },
      },
      errors: [
        {
          message: "validation detail",
          extensions: { code: "VALIDATION_ERROR" },
        },
      ],
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).write(
        write("issues.create", { teamId: "t1", title: "New issue" }),
        tokens,
      ),
    ).rejects.toMatchObject({ code: "invalid-request", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps data:null plus ENTITY_NOT_FOUND to a not-found error", async () => {
    const fetcher = graphqlFetch({
      data: null,
      errors: [
        {
          message: "Entity not found",
          path: ["issue"],
          extensions: { code: "ENTITY_NOT_FOUND" },
        },
      ],
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "issues.read", input: { issueId: "uuid-9" } },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "not-found", retryable: false });
  });

  it("reads GraphQL error codes from extensions.type when code is absent", async () => {
    const fetcher = graphqlFetch({
      data: null,
      errors: [{ message: "not found", extensions: { type: "not_found" } }],
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("Linear GraphQL — absent and malformed roots fail closed", () => {
  it("throws instead of returning an empty page when the connection root is absent", async () => {
    const fetcher = dataFetch({});
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "provider-unavailable", retryable: true });
  });

  it("throws instead of returning an empty page when the connection root is null", async () => {
    const fetcher = dataFetch({ teams: null });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("maps a null single-object root to not-found, never an empty page", async () => {
    const fetcher = dataFetch({ issue: null });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "issues.read", input: { issueId: "uuid-9" } },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "not-found", retryable: false });
  });

  it("maps a null issue root for comments.read to not-found", async () => {
    const fetcher = dataFetch({ issue: null });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "comments.read", input: { issueId: "uuid-1" } },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects a malformed response that is neither data nor errors", async () => {
    const fetcher = vi.fn(async () => response({ unexpected: true }));
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "provider-unavailable", retryable: true });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toThrow(/malformed/i);
  });

  it("rejects a connection whose nodes are not an array", async () => {
    const fetcher = dataFetch({
      teams: {
        nodes: "nope",
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toThrow(/malformed/i);
  });
});

describe("Linear GraphQL — nodes and pagination integrity", () => {
  it("filters null nodes while preserving valid entries", async () => {
    const fetcher = dataFetch({
      teams: {
        nodes: [null, { id: "t1", key: "FBL" }, { id: "t2", key: "FRT" }, null],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await createLinearAdapter({
      ...common,
      fetch: fetcher,
    }).read({ capability: "teams.read", input: {} }, tokens);
    expect(result.items).toEqual([
      { id: "t1", key: "FBL" },
      { id: "t2", key: "FRT" },
    ]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("fails closed when hasNextPage is true without a usable endCursor", async () => {
    const fetcher = dataFetch({
      teams: {
        nodes: [{ id: "t1" }],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toMatchObject({ code: "provider-unavailable", retryable: false });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {} },
        tokens,
      ),
    ).rejects.toThrow(/malformed/i);
  });

  it("fails closed on a repeated cursor instead of looping forever", async () => {
    const fetcher = dataFetch({
      teams: {
        nodes: [{ id: "t1" }],
        pageInfo: { hasNextPage: true, endCursor: "page-1" },
      },
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {}, cursor: "page-1" },
        tokens,
      ),
    ).rejects.toThrow(/repeated/i);
  });

  it("forwards a distinct next cursor for the next page", async () => {
    const fetcher = dataFetch({
      issues: {
        nodes: [{ id: "i1", identifier: "FBL-1" }],
        pageInfo: { hasNextPage: true, endCursor: "page-2" },
      },
    });
    const result = await createLinearAdapter({
      ...common,
      fetch: fetcher,
    }).read({ capability: "issues.read", input: {}, cursor: "page-1" }, tokens);
    expect(result.items[0]).toMatchObject({ id: "i1", identifier: "FBL-1" });
    expect(result.nextCursor).toBe("page-2");
  });

  it("returns no cursor when the last page is complete", async () => {
    const fetcher = dataFetch({
      projects: {
        nodes: [{ id: "p1", name: "Roadmap" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await createLinearAdapter({
      ...common,
      fetch: fetcher,
    }).read({ capability: "projects.read", input: {} }, tokens);
    expect(result.items[0]).toMatchObject({ id: "p1" });
    expect(result.nextCursor).toBeUndefined();
  });
});

describe("Linear GraphQL — mutation success handling", () => {
  it("returns the mutation payload only when success is exactly true", async () => {
    const fetcher = dataFetch({
      issueCreate: {
        success: true,
        issue: {
          id: "i1",
          identifier: "FBL-1",
          title: "New issue",
          url: "https://linear.app/issue/FBL-1",
        },
      },
    });
    const result = await createLinearAdapter({
      ...common,
      fetch: fetcher,
    }).write(
      write("issues.create", { teamId: "t1", title: "New issue" }),
      tokens,
    );
    expect(result).toMatchObject({
      success: true,
      issue: { identifier: "FBL-1" },
    });
  });

  it("surfaces success:false as a deterministic, non-retryable failure", async () => {
    const fetcher = dataFetch({ issueCreate: { success: false, issue: null } });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).write(
        write("issues.create", { teamId: "t1", title: "x" }),
        tokens,
      ),
    ).rejects.toMatchObject({ code: "invalid-request", retryable: false });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).write(
        write("issues.create", { teamId: "t1", title: "x" }),
        tokens,
      ),
    ).rejects.toThrow(/did not succeed/);
  });

  it("rejects a null mutation root even when no errors are reported", async () => {
    const fetcher = dataFetch({ issueUpdate: null });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).write(
        write("issues.update", { issueId: "uuid-9", title: "x" }),
        tokens,
      ),
    ).rejects.toMatchObject({ code: "invalid-request", retryable: false });
  });
});

describe("Linear GraphQL — mutation input shaping", () => {
  it("forwards only Linear issue-create fields and drops routing identifiers", async () => {
    const fetcher = dataFetch({
      issueCreate: { success: true, issue: { id: "i1", identifier: "FBL-1" } },
    });
    await createLinearAdapter({ ...common, fetch: fetcher }).write(
      write("issues.create", {
        issueId: "routing",
        workspace: "Mivlet",
        team: "FBL",
        accountId: "acc",
        connectionId: "conn",
        teamId: "t1",
        title: "New issue",
        description: "details",
      }),
      tokens,
    );
    const body = await sentBody(fetcher);
    expect(body.variables.input).toEqual({
      teamId: "t1",
      title: "New issue",
      description: "details",
    });
    expect(body.query).toContain("issueCreate");
  });

  it("uses issueId as the routing id and never forwards it into the update input", async () => {
    const fetcher = dataFetch({
      issueUpdate: {
        success: true,
        issue: { id: "i9", identifier: "FBL-9", title: "Updated" },
      },
    });
    await createLinearAdapter({ ...common, fetch: fetcher }).write(
      write("issues.update", {
        issueId: "uuid-9",
        workspace: "Mivlet",
        team: "FBL",
        targetId: "tgt",
        title: "Updated",
        description: "details",
        teamId: "t1",
      }),
      tokens,
    );
    const body = await sentBody(fetcher);
    expect(body.variables.id).toBe("uuid-9");
    expect(body.variables.input).toEqual({
      title: "Updated",
      description: "details",
      teamId: "t1",
    });
    expect(JSON.stringify(body.variables.input)).not.toContain("uuid-9");
  });

  it("builds the comment input strictly from issueId and body", async () => {
    const fetcher = dataFetch({
      commentCreate: {
        success: true,
        comment: { id: "cm1", body: "looks good" },
      },
    });
    await createLinearAdapter({ ...common, fetch: fetcher }).write(
      write("comments.create", {
        issueId: "uuid-1",
        body: "looks good",
        workspace: "Mivlet",
        team: "FBL",
      }),
      tokens,
    );
    const body = await sentBody(fetcher);
    expect(body.variables.input).toEqual({
      issueId: "uuid-1",
      body: "looks good",
    });
  });
});

describe("Linear GraphQL — GraphQL error code mapping", () => {
  it.each([
    ["RATELIMITED", "rate-limited", true],
    ["AUTHENTICATION_ERROR", "expired-auth", false],
    ["FORBIDDEN", "permission-denied", false],
    ["ENTITY_NOT_FOUND", "not-found", false],
    ["NOT_FOUND", "not-found", false],
    ["VALIDATION_ERROR", "invalid-request", false],
    ["GRAPHQL_VALIDATION_FAILED", "invalid-request", false],
  ] as const)(
    "maps extensions.code %s to %s",
    async (code, expected, retryable) => {
      const fetcher = graphqlFetch({
        data: null,
        errors: [{ message: "provider detail", extensions: { code } }],
      });
      await expect(
        createLinearAdapter({ ...common, fetch: fetcher }).read(
          { capability: "teams.read", input: {} },
          tokens,
        ),
      ).rejects.toMatchObject({ code: expected, retryable });
    },
  );
});

describe("Linear GraphQL — cancellation", () => {
  it("rethrows AbortError for reads", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).read(
        { capability: "teams.read", input: {}, signal: controller.signal },
        tokens,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rethrows AbortError for writes", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(
      createLinearAdapter({ ...common, fetch: fetcher }).write(
        write("issues.create", { teamId: "t1", title: "x" }, controller.signal),
        tokens,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
