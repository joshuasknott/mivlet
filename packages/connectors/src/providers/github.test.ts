import { describe, expect, it, vi } from "vitest";
import type { ConnectorTokenSet } from "@fable/protocol";
import { createGitHubAdapter } from "./github";
import type { ProviderFetch } from "./http";

const tokens: ConnectorTokenSet = { accessToken: "test-token", tokenType: "Bearer", scopes: [] };
const common = { clientId: "client", authBaseUrl: "https://auth.example/", redirectUri: "http://127.0.0.1:43123/callback" };

function response(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers }
  });
}

function requestedUrl(fetcher: ReturnType<typeof vi.fn>): URL {
  return new URL(String(fetcher.mock.calls[0][0]));
}

describe("GitHub production adapter — pagination", () => {
  it("forwards a validated numeric cursor and derives the next cursor from a same-origin link", async () => {
    const fetcher = vi.fn(async () => response([{ id: 2, full_name: "acme/fable" }], 200, {
      link: '<https://api.github.com/user/repos?page=3>; rel="next"'
    }));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "repositories.list", input: { limit: 10 }, cursor: "2" }, tokens);
    const url = requestedUrl(fetcher);
    expect(url.host).toBe("api.github.com");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(result.nextCursor).toBe("3");
  });

  it("starts at page one when no cursor is supplied", async () => {
    const fetcher = vi.fn(async () => response([{ id: 1 }], 200, {
      link: '<https://api.github.com/user/repos?page=2>; rel="next"'
    }));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "repositories.list", input: {} }, tokens);
    const url = requestedUrl(fetcher);
    expect(url.searchParams.get("page")).toBeNull();
    expect(result.nextCursor).toBe("2");
  });

  it("rejects malformed or non-positive cursors before any network call", async () => {
    for (const cursor of ["abc", "0", "-1", "1.5", "Infinity", "page-2", "2,3"]) {
      const fetcher = vi.fn(async () => response([]));
      const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
      await expect(adapter.read({ capability: "repositories.list", input: {}, cursor }, tokens))
        .rejects.toThrow(/positive page number/);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("ignores next links from other origins and malformed link entries", async () => {
    const crossOrigin = createGitHubAdapter({
      ...common,
      fetch: vi.fn(async () => response([{ id: 1 }], 200, {
        link: '<https://evil.example/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=3>; rel="last"'
      }))
    });
    const cross = await crossOrigin.read({ capability: "repositories.list", input: {} }, tokens);
    expect(cross.nextCursor).toBeUndefined();

    const badPort = createGitHubAdapter({
      ...common,
      fetch: vi.fn(async () => response([{ id: 1 }], 200, {
        link: '<https://api.github.com:8443/user/repos?page=2>; rel="next"'
      }))
    });
    const port = await badPort.read({ capability: "repositories.list", input: {} }, tokens);
    expect(port.nextCursor).toBeUndefined();

    const malformed = createGitHubAdapter({
      ...common,
      fetch: vi.fn(async () => response([{ id: 1 }], 200, {
        link: '<not a url>; rel="next"'
      }))
    });
    const broken = await malformed.read({ capability: "repositories.list", input: {} }, tokens);
    expect(broken.nextCursor).toBeUndefined();
  });

  it("accepts next links that share the configured API origin even on a custom base path", async () => {
    const fetcher = vi.fn(async () => response([{ id: 1 }], 200, {
      link: '<https://github.example.com/api/v3/user/repos?page=2>; rel="next"'
    }));
    const adapter = createGitHubAdapter({ ...common, apiBaseUrl: "https://github.example.com/api/v3/", fetch: fetcher });
    const result = await adapter.read({ capability: "repositories.list", input: {} }, tokens);
    expect(result.nextCursor).toBe("2");
  });

  it("does not emit a next cursor that fails to advance past the current page", async () => {
    for (const link of [
      '<https://api.github.com/user/repos?page=3>; rel="next"',
      '<https://api.github.com/user/repos?page=2>; rel="next"',
      '<https://api.github.com/user/repos?page=0>; rel="next"'
    ]) {
      const fetcher = vi.fn(async () => response([{ id: 1 }], 200, { link }));
      const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
      const result = await adapter.read({ capability: "repositories.list", input: {}, cursor: "3" }, tokens);
      expect(result.nextCursor).toBeUndefined();
    }
  });

  it("returns an empty page for an empty repository list without a cursor", async () => {
    const fetcher = vi.fn(async () => response([]));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "repositories.list", input: {} }, tokens);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});

describe("GitHub production adapter — result handling", () => {
  it("preserves mixed issue and pull request list results with their discriminators", async () => {
    const fetcher = vi.fn(async () => response([
      { id: 1, number: 1, title: "Bug report", state: "open", html_url: "https://github.com/acme/fable/issues/1" },
      { id: 2, number: 2, title: "Ship pagination", state: "open", pull_request: { url: "https://api.github.com/repos/acme/fable/pulls/2" } }
    ]));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "issues.read", input: { repository: "acme/fable", limit: 5 } }, tokens);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ id: 1, number: 1, title: "Bug report" });
    expect(result.items[1]).toMatchObject({ id: 2, number: 2, title: "Ship pagination" });
    expect(result.items[1].pull_request).toMatchObject({ url: "https://api.github.com/repos/acme/fable/pulls/2" });
  });

  it("extracts search items while preserving truncation evidence in the raw payload", async () => {
    const fetcher = vi.fn(async () => response({
      total_count: 412,
      incomplete_results: true,
      items: [{ id: 1, full_name: "acme/fable" }]
    }));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "repositories.search", input: { query: "fable" } }, tokens);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 1, full_name: "acme/fable" });
  });

  it("redacts tokens and email keys from provider objects", async () => {
    const fetcher = vi.fn(async () => response([{ id: 1, full_name: "acme/fable", token: "secret", authorization: "Bearer secret", email: "octo@example.invalid" }]));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    const result = await adapter.read({ capability: "repositories.list", input: {} }, tokens);
    expect(JSON.stringify(result.items[0])).not.toContain("secret");
    expect(result.items[0]).not.toHaveProperty("email");
  });

  it("fails closed on malformed response bodies without leaking provider detail", async () => {
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

describe("GitHub production adapter — request shaping", () => {
  it("clamps per_page into the documented GitHub window and rejects non-finite limits", async () => {
    for (const [limit, expected] of [[9999, "100"], [-5, "1"], [0, "1"], [10.9, "10"], [undefined, "30"], [Number.NaN, "30"]] as const) {
      const fetcher = vi.fn(async () => response([]));
      const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
      await adapter.read({ capability: "repositories.list", input: limit === undefined ? {} : { limit } }, tokens);
      expect(requestedUrl(fetcher).searchParams.get("per_page")).toBe(expected);
    }
  });

  it("rejects repositories that are not in owner/name form before any network call", async () => {
    for (const repository of ["acme", "acme/fable/extra", "acme//fable", "/fable", "acme/", "acme/fable/"]) {
      const fetcher = vi.fn(async () => response([]));
      const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
      await expect(adapter.read({ capability: "branches.read", input: { repository } }, tokens))
        .rejects.toThrow(/owner\/name form/);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("encodes nested file paths and refs without corrupting them", async () => {
    const fetcher = vi.fn(async () => response({ id: 1, name: "a b.ts" }));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    await adapter.read({
      capability: "files.read",
      input: { repository: "acme/fable", path: "src/lib/a b.ts", ref: "feature/nested-branch" }
    }, tokens);
    const url = requestedUrl(fetcher);
    expect(url.pathname).toBe("/repos/acme/fable/contents/src/lib/a%20b.ts");
    expect(url.searchParams.get("ref")).toBe("feature/nested-branch");
  });

  it("keeps the bearer token in the Authorization header, never in the URL", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => response([]));
    const adapter = createGitHubAdapter({ ...common, fetch: fetcher });
    await adapter.read({ capability: "repositories.list", input: {}, cursor: "2" }, tokens);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).not.toContain("test-token");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-token" });
  });
});
