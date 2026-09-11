import { describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalRecord, ConnectorTokenSet } from "@fable/protocol";
import { ConnectorRuntime } from "../sdk";
import type { ProviderFetch } from "./http";
import { createNotionAdapter, normalizeNotionObject, NOTION_CAPABILITIES } from "./notion-api";

const tokens: ConnectorTokenSet = { accessToken: "test-token", tokenType: "Bearer", scopes: [] };
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const base = { authBaseUrl: "https://auth.example/", clientId: "client", redirectUri: "http://127.0.0.1:43123/callback" };
const notion = (fetch: ProviderFetch) => createNotionAdapter({ ...base, fetch });
const list = (results: unknown[], hasMore = false, nextCursor?: string) => ({ object: "list", results, has_more: hasMore, next_cursor: hasMore && nextCursor ? nextCursor : null });

describe("Notion API version compatibility", () => {
  it("pins the still-supported 2022-06-28 version for the unchanged page/block/search/database surface", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json(list([{ id: "p1", object: "page" }])));
    const adapter = notion(fetcher);
    await adapter.read({ capability: "notion.search", input: { query: "q" } }, tokens);
    await adapter.read({ capability: "notion.page.read", input: { pageId: "page-1" } }, tokens);
    await adapter.read({ capability: "notion.blocks.read", input: { blockId: "block-1" } }, tokens);
    await adapter.read({ capability: "notion.database.query", input: { databaseId: "db-1" } }, tokens);
    for (const [url] of fetcher.mock.calls) {
      expect(new URL(String(url)).pathname.startsWith("/v1/data_sources/")).toBe(false);
    }
    for (const [, init] of fetcher.mock.calls) {
      expect((init?.headers as Record<string, string> | undefined)?.["notion-version"]).toBe("2022-06-28");
    }
  });

  it("uses the minimum data-source version (2025-09-03) only for explicit data-source queries", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json(list([{ id: "row-1", object: "page" }])));
    const adapter = notion(fetcher);
    await adapter.read({ capability: "notion.database.query", input: { dataSourceId: "ds-1", filter: { property: "Status", select: { equals: "Done" } } } }, tokens);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://api.notion.com/v1/data_sources/ds-1/query");
    expect((init?.headers as Record<string, string> | undefined)?.["notion-version"]).toBe("2025-09-03");
    expect(JSON.parse(String(init?.body))).toMatchObject({ filter: { property: "Status", select: { equals: "Done" } }, page_size: 100 });
  });
});

describe("Notion pagination", () => {
  it("maps has_more and start_cursor for search", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json(list([{ id: "p1", object: "page" }], true, "next")));
    const result = await notion(fetcher).read({ capability: "notion.search", input: { query: "roadmap", pageSize: 25 }, cursor: "cursor" }, tokens);
    const [, init] = fetcher.mock.calls[0];
    expect(String(new URL(String(fetcher.mock.calls[0][0])))).toBe("https://api.notion.com/v1/search");
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: "roadmap", page_size: 25, start_cursor: "cursor" });
    expect(result.nextCursor).toBe("next");
    expect(result.items).toHaveLength(1);
  });

  it("paginates block children through query parameters", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json(list([{ id: "b1", object: "block" }], true, "block-next")));
    const result = await notion(fetcher).read({ capability: "notion.blocks.read", input: { blockId: "page-1", pageSize: 20 }, cursor: "bc" }, tokens);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/v1/blocks/page-1/children");
    expect(url.searchParams.get("page_size")).toBe("20");
    expect(url.searchParams.get("start_cursor")).toBe("bc");
    expect(result.nextCursor).toBe("block-next");
  });

  it("paginates database and data-source queries with identical cursor handling", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json(list([{ id: "r1", object: "page" }], true, "q-next")));
    const adapter = notion(fetcher);
    const database = await adapter.read({ capability: "notion.database.query", input: { databaseId: "db-1" }, cursor: "c1" }, tokens);
    const dataSource = await adapter.read({ capability: "notion.database.query", input: { dataSourceId: "ds-1" }, cursor: "c2" }, tokens);
    expect(database.nextCursor).toBe("q-next");
    expect(dataSource.nextCursor).toBe("q-next");
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0]).toMatchObject({ start_cursor: "c1", page_size: 100 });
    expect(bodies[1]).toMatchObject({ start_cursor: "c2", page_size: 100 });
  });
});

describe("Notion database and data-source IDs", () => {
  it("never conflates databaseId and dataSourceId", async () => {
    await expect(notion(vi.fn()).read({ capability: "notion.database.query", input: { databaseId: "db-1", dataSourceId: "ds-1" } }, tokens)).rejects.toThrow("mutually exclusive");
  });

  it("requires an explicit source identifier", async () => {
    await expect(notion(vi.fn()).read({ capability: "notion.database.query", input: {} }, tokens)).rejects.toThrow("databaseId or dataSourceId is required");
  });

  it("keeps stored database references on the original database query path without relabeling", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json(list([{ id: "r1", object: "page" }])));
    await notion(fetcher).read({ capability: "notion.database.query", input: { databaseId: "db-stored" } }, tokens);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://api.notion.com/v1/databases/db-stored/query");
    expect((init?.headers as Record<string, string> | undefined)?.["notion-version"]).toBe("2022-06-28");
  });
});

describe("Notion response normalization", () => {
  it("treats block content as opaque untrusted data and preserves its rich text verbatim", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json(list([
      { id: "b1", object: "block", type: "paragraph", has_children: false, paragraph: { rich_text: [{ type: "text", text: { content: "hello" }, annotations: { bold: true } }], color: "default" } },
      { id: "b2", object: "block", type: "to_do", has_children: true, to_do: { rich_text: [{ type: "text", text: { content: "task" } }], checked: false } }
    ])));
    const result = await notion(fetcher).read({ capability: "notion.blocks.read", input: { blockId: "page-1" } }, tokens);
    expect(result.items[0]).toMatchObject({ type: "paragraph", hasChildren: false });
    expect(result.items[0].content).toEqual({ rich_text: [{ type: "text", text: { content: "hello" }, annotations: { bold: true } }], color: "default" });
    expect(result.items[1]).toMatchObject({ type: "to_do", hasChildren: true });
  });

  it("defaults missing properties and surfaces archived/in_trash state", () => {
    expect(normalizeNotionObject({ id: "p1", object: "page" })).toMatchObject({ properties: {}, archived: false });
    expect(normalizeNotionObject({ id: "p2", object: "page", archived: true })).toMatchObject({ archived: true });
    expect(normalizeNotionObject({ id: "b1", object: "block", in_trash: true })).toMatchObject({ archived: true });
  });

  it("maps inaccessible and deleted resources to permission and not-found errors", async () => {
    const adapter = notion(vi.fn(async () => json({ code: "restricted_resource" }, 403)));
    await expect(adapter.read({ capability: "notion.page.read", input: { pageId: "hidden" } }, tokens)).rejects.toMatchObject({ code: "permission-denied" });
    const deleted = notion(vi.fn(async () => json({ code: "object_not_found" }, 404)));
    await expect(deleted.read({ capability: "notion.page.read", input: { pageId: "deleted" } }, tokens)).rejects.toMatchObject({ code: "not-found" });
  });

  it("degrades a malformed list response to empty items instead of failing the whole page", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json({ object: "list", results: "not-an-array", has_more: true }));
    const result = await notion(fetcher).read({ capability: "notion.search", input: { query: "q" } }, tokens);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it("fails closed on malformed and non-JSON error bodies", async () => {
    await expect(notion(vi.fn(async () => new Response("bad"))).read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({ code: "provider-unavailable" });
    await expect(notion(vi.fn(async () => new Response("<html>not json</html>", { status: 200 }))).read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({ code: "provider-unavailable" });
    await expect(notion(vi.fn(async () => json("not-an-object", 200))).read({ capability: "notion.search", input: {} }, tokens)).rejects.toThrow("Notion returned an invalid list response.");
  });

  it("maps rate limits to retryable rate-limited errors", async () => {
    await expect(notion(vi.fn(async () => json({ code: "rate_limited" }, 429, { "retry-after": "3" }))).read({ capability: "notion.search", input: {} }, tokens)).rejects.toMatchObject({ code: "rate-limited", retryable: true, retryAfter: "3000" });
  });
});

describe("Notion write-success validation", () => {
  it("returns created and updated objects only when they match the expected Notion object", async () => {
    const fetcher = vi.fn<ProviderFetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/comments")) return json({ object: "comment", id: "c1" });
      return json({ object: "page", id: "new-page" });
    });
    const adapter = notion(fetcher);
    await expect(adapter.write({ capability: "notion.page.create", input: { parent: {}, properties: {} }, target: "t", preview: "p", riskLevel: "medium" }, tokens)).resolves.toMatchObject({ object: "page", id: "new-page" });
    await expect(adapter.write({ capability: "notion.page.update", input: { pageId: "p1", patch: { properties: {} } }, target: "t", preview: "p", riskLevel: "medium" }, tokens)).resolves.toMatchObject({ object: "page", id: "new-page" });
    await expect(adapter.write({ capability: "notion.comment.create", input: { parent: {}, rich_text: [] }, target: "t", preview: "p", riskLevel: "medium" }, tokens)).resolves.toMatchObject({ object: "comment", id: "c1" });
  });

  it("rejects a 200 that is not the object the write claimed to create", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json({ object: "database", id: "db-1" }));
    const adapter = notion(fetcher);
    await expect(adapter.write({ capability: "notion.page.create", input: {}, target: "t", preview: "p", riskLevel: "medium" }, tokens)).rejects.toThrow("invalid write result");
  });

  it("requires an id on created objects", async () => {
    await expect(notion(vi.fn(async () => json({ object: "page" }))).write({ capability: "notion.page.create", input: {}, target: "t", preview: "p", riskLevel: "medium" }, tokens)).rejects.toThrow("invalid write result");
  });

  it("requires append to return a list with results", async () => {
    await expect(notion(vi.fn(async () => json({ object: "page", id: "b1" }))).write({ capability: "notion.blocks.append", input: { blockId: "p1" }, target: "t", preview: "p", riskLevel: "medium" }, tokens)).rejects.toThrow("invalid write result");
    await expect(notion(vi.fn(async () => json({ object: "list", results: [{ id: "child" }] }))).write({ capability: "notion.blocks.append", input: { blockId: "p1" }, target: "t", preview: "p", riskLevel: "medium" }, tokens)).resolves.toMatchObject({ object: "list" });
  });

  it("accepts archived block responses for deletes and rejects malformed ones", async () => {
    await expect(notion(vi.fn(async () => json({ object: "block", id: "b1", archived: true }))).write({ capability: "notion.block.delete", input: { blockId: "b1" }, target: "t", preview: "p", riskLevel: "critical" }, tokens)).resolves.toMatchObject({ object: "block", id: "b1" });
    await expect(notion(vi.fn(async () => json({ object: "page", id: "b1" }))).write({ capability: "notion.block.delete", input: { blockId: "b1" }, target: "t", preview: "p", riskLevel: "critical" }, tokens)).rejects.toThrow("invalid write result");
  });
});

describe("Notion write approvals", () => {
  it("executes approved writes with the exact proposed body and completes the approval", async () => {
    const fetcher = vi.fn<ProviderFetch>(async () => json({ object: "page", id: "new-page" }));
    const adapter = notion(fetcher);
    const approvals = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({ ...record, result: "approved" as const, decidedAt: "2026-09-11T12:00:00Z" })),
      complete: vi.fn(async () => undefined)
    };
    const runtime = new ConnectorRuntime({ approvals });
    runtime.register(adapter);
    const body = { parent: { database_id: "db-1" }, properties: { Name: { title: [{ type: "text", text: { content: "Exact title" } }] } } };
    const result = await runtime.write({ connectorId: "notion", account: { id: "ws", displayName: "Workspace" }, tokens }, { capability: "notion.page.create", input: body, target: "db-1", preview: "Exact title", riskLevel: "medium" });
    expect(result).toMatchObject({ object: "page", id: "new-page" });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://api.notion.com/v1/pages");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(approvals.approve).toHaveBeenCalledOnce();
    expect(approvals.complete).toHaveBeenCalledWith(expect.objectContaining({ result: "completed" }));
  });

  it("refuses to run an unapproved Notion write and never touches the API", async () => {
    const fetcher = vi.fn<ProviderFetch>();
    const adapter = notion(fetcher);
    const approvals = {
      approve: vi.fn(async (record: ConnectorApprovalRecord) => ({ ...record, result: "denied" as const, decidedAt: "2026-09-11T12:00:00Z" })),
      complete: vi.fn(async () => undefined)
    };
    const runtime = new ConnectorRuntime({ approvals });
    runtime.register(adapter);
    await expect(runtime.write({ connectorId: "notion", account: { id: "ws", displayName: "Workspace" }, tokens }, { capability: "notion.page.create", input: { parent: {} }, target: "db-1", preview: "Exact title", riskLevel: "medium" })).rejects.toMatchObject({ code: "approval-required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("registers all external Notion mutations as consequential", () => {
    expect(NOTION_CAPABILITIES.filter((capability) => capability.kind === "write").every((capability) => capability.consequential)).toBe(true);
  });
});