import {
  HOSTED_TEXT_TASK_LIMITS,
  readMivletEnvValue,
  signHostedTaskCapability,
  type HostedTaskCapabilityReceipt,
  type HostedTaskCapabilityScope,
} from "@mivlet/protocol";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import { requireActiveDevice, requireRole } from "./authorization";
import { requireHttpClerkIdentity, type ConvexAuthReader } from "./convexAuth";
import { hostedRunnerBaseUrl } from "./hostedExecutionPolicy";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const SCOPES: readonly HostedTaskCapabilityScope[] = [
  "task:admit", "task:read", "task:cancel", "task:input", "task:output",
  "credential:enroll", "credential:read", "credential:revoke",
];

export interface HostedTaskCapabilityArgs {
  workspaceId: string;
  deviceId: string;
  agentId: string;
  scope: HostedTaskCapabilityScope;
  resourceId: string;
  requestSha256: string;
}

/** Only identifiers and a digest reach Convex; never task text or a provider key. */
export function parseHostedTaskCapabilityArgs(value: unknown): HostedTaskCapabilityArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-request");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).sort().join(",") !== "agentId,deviceId,requestSha256,resourceId,scope,workspaceId"
    || ![args.workspaceId, args.deviceId, args.agentId, args.resourceId]
      .every(id => typeof id === "string" && ID.test(id))
    || typeof args.scope !== "string" || !SCOPES.includes(args.scope as HostedTaskCapabilityScope)
    || typeof args.requestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.requestSha256)
    || (args.scope === "credential:read" && args.resourceId !== "connections")) {
    throw new Error("invalid-request");
  }
  return value as HostedTaskCapabilityArgs;
}

/** Account authority only; the runner enforces each mode's deployment prerequisites. */
export const authorizeHostedTaskCapability = internalQuery({
  args: { workspaceId: v.string(), deviceId: v.string(), agentId: v.string() },
  returns: v.object({ accountId: v.string() }),
  handler: async (ctx, args) => {
    if (![args.workspaceId, args.deviceId, args.agentId].every(id => ID.test(id))) {
      throw new Error("invalid-request");
    }
    const authz = await requireActiveDevice(ctx, args.workspaceId, args.deviceId);
    requireRole(authz.membership.role, ["owner", "admin", "editor"]);
    const accountId: unknown = authz.user.internalUserId;
    if (typeof accountId !== "string" || !ID.test(accountId)) throw new Error("account-unavailable");
    return { accountId };
  },
});

/** The HTTP gate and action both assert identity; internal calls must retain it. */
export async function mintHostedTaskCapability(
  ctx: ConvexAuthReader & { runQuery: Function },
  value: HostedTaskCapabilityArgs,
): Promise<HostedTaskCapabilityReceipt> {
  await requireHttpClerkIdentity(ctx);
  const args = parseHostedTaskCapabilityArgs(value);
  const authorized: { accountId: string } = await ctx.runQuery(
    internal.hostedTasks.authorizeHostedTaskCapability,
    { workspaceId: args.workspaceId, deviceId: args.deviceId, agentId: args.agentId },
  );
  // Separate secret and token domain: a computer lifecycle key grants no task access.
  const key = readMivletEnvValue(process.env, "HOSTED_TASK_SIGNING_KEY");
  if (!key || key.length < 32) throw new Error("runner-configuration-required");
  const runnerUrl = hostedRunnerBaseUrl(readMivletEnvValue(process.env, "HOSTED_TASK_URL"))
    .toString().replace(/\/$/, "");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + HOSTED_TEXT_TASK_LIMITS.capabilityMs;
  const token = await signHostedTaskCapability(key, {
    version: 1,
    accountId: authorized.accountId,
    ...args,
    issuedAt,
    expiresAt,
    nonce: `task-cap-${crypto.randomUUID()}`,
  });
  return { runnerUrl, token, expiresAt };
}

/** Native HTTP only: capabilities must never enter renderer or model state. */
export const requestHostedTaskCapability = internalAction({
  args: {
    workspaceId: v.string(), deviceId: v.string(), agentId: v.string(),
    scope: v.union(
      v.literal("task:admit"), v.literal("task:read"), v.literal("task:cancel"),
      v.literal("task:input"), v.literal("task:output"),
      v.literal("credential:enroll"), v.literal("credential:read"), v.literal("credential:revoke"),
    ),
    resourceId: v.string(), requestSha256: v.string(),
  },
  returns: v.object({ runnerUrl: v.string(), token: v.string(), expiresAt: v.number() }),
  handler: mintHostedTaskCapability,
});
