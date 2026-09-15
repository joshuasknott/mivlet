import { describe, expect, it } from "vitest";
import { requireActiveDevice, requireActiveMembership, requireFableUser } from "./authorization";

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

function principalDocs() {
  return {
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
  } satisfies Tables;
}

function fixture(tables: Tables, identity: Record<string, unknown> = {}) {
  const ctx = {
    db: {
      query: (table: string) => new FakeQuery(tables[table] ?? []),
    },
    auth: {
      getUserIdentity: async () => ({
        subject: "owner",
        issuer: "https://issuer.example",
        tokenIdentifier: "https://issuer.example|owner",
        ...identity,
      }),
    },
  };
  return { ctx, tables };
}

describe("soft device binding", () => {
  it("binds an owned active device and workspace link to the Clerk principal", async () => {
    const { ctx } = fixture({
      ...principalDocs(),
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
    });
    const bound = await requireActiveDevice(ctx, "workspace_1", "device_1");
    expect(bound.user.internalUserId).toBe("usr_1");
    expect(bound.device.deviceId).toBe("device_1");
    expect(bound.link.memberId).toBe("mem_1");
  });

  it("rejects a device owned by a different account", async () => {
    const { ctx } = fixture({
      ...principalDocs(),
      account_devices: [
        {
          _id: "account_devices:1",
          deviceId: "device_1",
          internalUserId: "usr_other",
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
    });
    await expect(requireActiveDevice(ctx, "workspace_1", "device_1")).rejects.toThrow(
      /device link is required/i,
    );
  });

  it("rejects a revoked device even when the workspace link is still present", async () => {
    const { ctx } = fixture({
      ...principalDocs(),
      account_devices: [
        {
          _id: "account_devices:1",
          deviceId: "device_1",
          internalUserId: "usr_1",
          status: "revoked",
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
    });
    await expect(requireActiveDevice(ctx, "workspace_1", "device_1")).rejects.toThrow(
      /device link is required/i,
    );
  });

  it("rejects a claimed device that was never linked", async () => {
    const { ctx } = fixture({
      ...principalDocs(),
      account_devices: [],
      workspace_device_links: [],
    });
    await expect(requireFableUser(ctx)).resolves.toMatchObject({
      user: { internalUserId: "usr_1" },
    });
    await expect(requireActiveMembership(ctx, "workspace_1")).resolves.toMatchObject({
      membership: { memberId: "mem_1" },
    });
    await expect(requireActiveDevice(ctx, "workspace_1", "device_missing")).rejects.toThrow(
      /device link is required/i,
    );
  });
});
