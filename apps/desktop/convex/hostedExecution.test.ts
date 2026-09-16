import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import {
  consumeExecutionCapabilityMint,
  getComputer,
  mintExecutionCapability,
  requestExecutionCapability,
  requestProvision,
} from "./hostedExecution";
import { hostedComputerId } from "./hostedExecutionPolicy";

type ConvexFunctionVisibility = {
  isAction?: boolean;
  isInternal?: boolean;
  isMutation?: boolean;
  isQuery?: boolean;
};

function visibility(value: unknown): ConvexFunctionVisibility {
  return (value ?? {}) as ConvexFunctionVisibility;
}

function isPublicClientFunction(value: unknown): boolean {
  const fn = visibility(value);
  return (
    Boolean(fn.isQuery || fn.isMutation || fn.isAction) &&
    fn.isInternal !== true
  );
}

describe("hosted execution capability minting", () => {
  it("keeps capability minting off the public Convex client path", () => {
    expect(visibility(requestExecutionCapability).isAction).toBe(true);
    expect(visibility(requestExecutionCapability).isInternal).toBe(true);
    expect(isPublicClientFunction(requestExecutionCapability)).toBe(false);
    expect(visibility(consumeExecutionCapabilityMint).isMutation).toBe(true);
    expect(visibility(consumeExecutionCapabilityMint).isInternal).toBe(true);
    expect(isPublicClientFunction(consumeExecutionCapabilityMint)).toBe(false);
    expect(isPublicClientFunction(requestProvision)).toBe(true);
    expect(isPublicClientFunction(getComputer)).toBe(true);
  });

  it("fails closed in the mint action when Clerk identity is absent", async () => {
    const ctx = {
      auth: { getUserIdentity: async () => null },
      runQuery: async () => {
        throw new Error("authorize should not run without Clerk identity");
      },
    };
    await expect(
      mintExecutionCapability(ctx, {
        workspaceId: "workspace_1",
        deviceId: "device_1",
        agentId: "agent_1",
        scope: "process:launch",
      }),
    ).rejects.toThrow("authentication-required");
  });

  it("exposes minting only on the internal function table", () => {
    type PublicHosted = typeof api.hostedExecution;
    type InternalHosted = typeof internal.hostedExecution;
    type PublicMint = PublicHosted extends {
      requestExecutionCapability: unknown;
    }
      ? true
      : false;
    type InternalMint = InternalHosted extends {
      requestExecutionCapability: unknown;
    }
      ? true
      : false;
    type InternalConsume = InternalHosted extends {
      consumeExecutionCapabilityMint: unknown;
    }
      ? true
      : false;
    const publicClientCannotMint: PublicMint = false;
    const internalCanMint: InternalMint = true;
    const internalCanConsume: InternalConsume = true;
    expect(publicClientCannotMint).toBe(false);
    expect(internalCanMint).toBe(true);
    expect(internalCanConsume).toBe(true);
    // @ts-expect-error public Convex clients cannot mint hosted capabilities
    void api.hostedExecution.requestExecutionCapability;
    // @ts-expect-error public Convex clients cannot consume mint windows
    void api.hostedExecution.consumeExecutionCapabilityMint;
  });
});

type Doc = Record<string, any> & { _id: string };
type Tables = Record<string, Doc[]>;

class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];

  constructor(private readonly docs: Doc[]) {}

  withIndex(
    _index: string,
    build: (query: { eq: (field: string, value: unknown) => any }) => unknown,
  ) {
    const query = {
      eq: (field: string, value: unknown): any => {
        this.filters.push([field, value]);
        return query;
      },
    };
    build(query);
    return this;
  }

  async collect() {
    return this.docs.filter((doc) =>
      this.filters.every(([field, value]) => doc[field] === value),
    );
  }
}

function provisionFixture() {
  const tables: Tables = {
    internal_users: [
      { _id: "internal_users:1", internalUserId: "usr_1", status: "active" },
    ],
    external_identity_links: [
      {
        _id: "external_identity_links:1",
        provider: "clerk",
        normalizedIssuer: "https://issuer.example",
        subject: "owner",
        internalUserId: "usr_1",
        status: "active",
      },
    ],
    workspaces: [
      { _id: "workspaces:1", workspaceId: "workspace_1", status: "active" },
    ],
    workspace_memberships: [
      {
        _id: "workspace_memberships:1",
        workspaceId: "workspace_1",
        internalUserId: "usr_1",
        memberId: "mem_1",
        role: "editor",
        status: "active",
      },
    ],
    account_devices: [
      {
        _id: "account_devices:1",
        deviceId: "device_1",
        internalUserId: "usr_1",
        status: "active",
      },
    ],
    workspace_device_links: [
      {
        _id: "workspace_device_links:1",
        workspaceId: "workspace_1",
        deviceId: "device_1",
        internalUserId: "usr_1",
        memberId: "mem_1",
        status: "active",
      },
    ],
    hosted_execution_nodes: [],
    hosted_execution_requests: [],
  };
  let sequence = 0;
  const scheduled: Array<{ args: unknown }> = [];
  const db = {
    query: (table: string) => new FakeQuery(tables[table] ?? []),
    insert: async (table: string, value: Record<string, unknown>) => {
      const id = `${table}:${++sequence}`;
      (tables[table] ??= []).push({ _id: id, ...value });
      return id;
    },
    patch: async (id: string, value: Record<string, unknown>) => {
      const doc = Object.values(tables).flat().find((entry) => entry._id === id);
      if (!doc) throw new Error(`Missing ${id}`);
      Object.assign(doc, value);
    },
  };
  const ctx = {
    db,
    auth: {
      getUserIdentity: async () => ({
        subject: "owner",
        issuer: "https://issuer.example",
        tokenIdentifier: "https://issuer.example|owner",
      }),
    },
    scheduler: {
      runAfter: async (_delay: number, _name: unknown, args: unknown) => {
        scheduled.push({ args });
        return `job:${scheduled.length}`;
      },
    },
  };
  const request = (args: {
    requestKey: string;
    agentId?: string;
    workspaceId?: string;
    deviceId?: string;
  }) =>
    (requestProvision as any)._handler(ctx, {
      workspaceId: "workspace_1",
      deviceId: "device_1",
      agentId: "agent_1",
      ...args,
    });
  return { tables, scheduled, request };
}

describe("hosted execution provision idempotency", () => {
  it("replays the same requestKey without scheduling again", async () => {
    const f = provisionFixture();
    const first = await f.request({ requestKey: "req-a" });
    const replay = await f.request({ requestKey: "req-a" });
    expect(replay).toEqual(first);
    expect(first.status).toBe("pending");
    expect(f.tables.hosted_execution_requests).toHaveLength(1);
    expect(f.scheduled).toHaveLength(1);
    expect(f.scheduled[0]?.args).toEqual({
      requestId: f.tables.hosted_execution_requests[0]?._id,
    });
  });

  it("returns the in-flight receipt for a distinct requestKey on the same computer", async () => {
    const f = provisionFixture();
    const first = await f.request({ requestKey: "req-a" });
    const concurrent = await f.request({ requestKey: "req-b" });
    expect(concurrent).toEqual(first);
    expect(concurrent.requestKey).toBe("req-a");
    expect(f.tables.hosted_execution_requests).toHaveLength(1);
    expect(f.tables.hosted_execution_requests[0]?.requestKey).toBe("req-a");
    expect(f.tables.hosted_execution_nodes).toHaveLength(1);
    expect(f.tables.hosted_execution_nodes[0]?.revision).toBe(1);
    expect(f.scheduled).toHaveLength(1);
  });

  it("allows a new requestKey after the in-flight provision settles", async () => {
    const f = provisionFixture();
    const first = await f.request({ requestKey: "req-a" });
    f.tables.hosted_execution_requests[0]!.status = "completed";
    const next = await f.request({ requestKey: "req-b" });
    expect(next.requestKey).toBe("req-b");
    expect(next.status).toBe("pending");
    expect(next.computerId).toBe(first.computerId);
    expect(f.tables.hosted_execution_requests).toHaveLength(2);
    expect(f.scheduled).toHaveLength(2);
  });

  it("does not coalesce distinct computers", async () => {
    const f = provisionFixture();
    const first = await f.request({ requestKey: "req-a", agentId: "agent_1" });
    const other = await f.request({ requestKey: "req-b", agentId: "agent_2" });
    expect(first.computerId).not.toBe(other.computerId);
    expect(other.requestKey).toBe("req-b");
    expect(f.tables.hosted_execution_requests).toHaveLength(2);
    expect(f.scheduled).toHaveLength(2);
  });

  it("fails closed when more than one pending provision exists for a computer", async () => {
    const f = provisionFixture();
    const computerId = hostedComputerId("workspace_1", "agent_1");
    const executionNodeId = `execution-node-${computerId}`;
    f.tables.hosted_execution_requests.push(
      {
        _id: "hosted_execution_requests:legacy-1",
        requestKey: "req-legacy-1",
        workspaceId: "workspace_1",
        agentId: "agent_1",
        executionNodeId,
        computerId,
        operation: "provision",
        status: "pending",
      },
      {
        _id: "hosted_execution_requests:legacy-2",
        requestKey: "req-legacy-2",
        workspaceId: "workspace_1",
        agentId: "agent_1",
        executionNodeId,
        computerId,
        operation: "provision",
        status: "pending",
      },
    );
    await expect(f.request({ requestKey: "req-new" })).rejects.toThrow(
      /hosted execution request is unavailable/i,
    );
    expect(f.scheduled).toHaveLength(0);
  });
});
