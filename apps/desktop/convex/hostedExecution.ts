import {
  readMivletEnvValue,
  signHostedExecutionCapability,
  type HostedComputerSnapshot,
  type HostedExecutionCapabilityReceipt,
  type HostedExecutionCapabilityScope
} from "@mivlet/protocol";
import { v } from "convex/values";
import { requireActiveDevice, requireActiveMembership, requireRole } from "./authorization";
import { requireHttpClerkIdentity, type ConvexAuthReader } from "./convexAuth";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import {
  hostedComputerId,
  hostedRunnerBaseUrl,
  requireHostedIdentifier,
  validateHostedComputerSnapshot
} from "./hostedExecutionPolicy";

const MAX_RUNNER_RESPONSE_BYTES = 64 * 1024;
const EXECUTION_CAPABILITY_LIFETIME_MS = 2 * 60_000;
export const requestProvision = mutation({
  args: { workspaceId: v.string(), deviceId: v.string(), agentId: v.string(), requestKey: v.string() },
  handler: async (ctx, args) => {
    const authz = await requireActiveDevice(ctx, args.workspaceId, args.deviceId);
    requireRole(authz.membership.role, ["owner", "admin", "editor"]);
    const agentId = requireHostedIdentifier(args.agentId, "Agent id");
    const requestKey = requireHostedIdentifier(args.requestKey, "Request key");
    const existingRequests = await ctx.db.query("hosted_execution_requests")
      .withIndex("by_request", (q) => q.eq("requestKey", requestKey)).collect();
    if (existingRequests.length > 1) throw new Error("The hosted execution request is unavailable.");
    const computerId = hostedComputerId(args.workspaceId, agentId);
    const executionNodeId = `execution-node-${computerId}`;
    const existing = existingRequests[0];
    if (existing) {
      if (existing.workspaceId !== args.workspaceId || existing.agentId !== agentId || existing.computerId !== computerId) {
        throw new Error("The hosted execution request is unavailable.");
      }
      return { requestKey, executionNodeId, computerId, status: existing.status };
    }
    const nodes = await ctx.db.query("hosted_execution_nodes")
      .withIndex("by_workspace_agent", (q) => q.eq("workspaceId", args.workspaceId).eq("agentId", agentId)).collect();
    if (nodes.length > 1) throw new Error("The hosted execution node is unavailable.");
    const now = Date.now();
    if (nodes[0]) {
      await ctx.db.patch(nodes[0]._id, {
        status: "provisioning", runtimeActive: false, keepAlive: false,
        revision: nodes[0].revision + 1, updatedAt: now
      });
    } else {
      await ctx.db.insert("hosted_execution_nodes", {
        executionNodeId, workspaceId: args.workspaceId, agentId, computerId, locality: "hosted",
        status: "provisioning", runtimeActive: false, keepAlive: false, runnerGeneration: 0, revision: 1,
        createdByInternalUserId: authz.user.internalUserId, createdByMemberId: authz.membership.memberId,
        createdByDeviceId: args.deviceId, createdAt: now, updatedAt: now
      });
    }
    const requestId = await ctx.db.insert("hosted_execution_requests", {
      requestKey, workspaceId: args.workspaceId, agentId, executionNodeId, computerId, operation: "provision", status: "pending",
      actorInternalUserId: authz.user.internalUserId, actorMemberId: authz.membership.memberId, actorDeviceId: args.deviceId,
      createdAt: now, updatedAt: now
    });
    await ctx.scheduler.runAfter(0, internal.hostedExecution.provisionScheduled, { requestId });
    return { requestKey, executionNodeId, computerId, status: "pending" as const };
  }
});

export const getComputer = query({
  args: { workspaceId: v.string(), agentId: v.string() },
  handler: async (ctx, args) => {
    await requireActiveMembership(ctx, args.workspaceId);
    const agentId = requireHostedIdentifier(args.agentId, "Agent id");
    const nodes = await ctx.db.query("hosted_execution_nodes")
      .withIndex("by_workspace_agent", (q) => q.eq("workspaceId", args.workspaceId).eq("agentId", agentId)).collect();
    if (nodes.length > 1) throw new Error("The hosted execution node is unavailable.");
    const node = nodes[0];
    if (!node) return null;
    return {
      executionNodeId: node.executionNodeId, workspaceId: node.workspaceId, agentId: node.agentId,
      locality: node.locality, status: node.status, runtimeActive: node.runtimeActive, keepAlive: node.keepAlive,
      runnerGeneration: node.runnerGeneration, revision: node.revision, updatedAt: node.updatedAt
    };
  }
});

export const authorizeExecutionCapability = internalQuery({
  args: { workspaceId: v.string(), deviceId: v.string(), agentId: v.string() },
  handler: async (ctx, args) => {
    const workspaceId = requireHostedIdentifier(args.workspaceId, "Workspace id");
    const deviceId = requireHostedIdentifier(args.deviceId, "Device id");
    const authz = await requireActiveDevice(ctx, workspaceId, deviceId);
    requireRole(authz.membership.role, ["owner", "admin", "editor"]);
    const agentId = requireHostedIdentifier(args.agentId, "Agent id");
    const nodes = await ctx.db.query("hosted_execution_nodes")
      .withIndex("by_workspace_agent", (q) => q.eq("workspaceId", workspaceId).eq("agentId", agentId)).collect();
    if (nodes.length !== 1) throw new Error("The hosted execution node is unavailable.");
    const node = nodes[0];
    if (node.status !== "ready" || !node.keepAlive || node.runnerGeneration < 1) {
      throw new Error("The hosted computer is not ready.");
    }
    return { computerId: node.computerId, generation: node.runnerGeneration };
  }
});

const executionCapabilityArgs = {
  workspaceId: v.string(),
  deviceId: v.string(),
  agentId: v.string(),
  scope: v.union(
    v.literal("process:launch"),
    v.literal("process:inspect"),
    v.literal("process:kill"),
    v.literal("browser:navigate"),
    v.literal("browser:act"),
    v.literal("browser:snapshot")
  )
};

/**
 * Mints a short-lived bearer capability for the native boundary. Internal so a
 * renderer Convex client cannot pull tokens into WebView state. Native calls
 * `/native/execution-capability` with the OS-keyring Clerk session.
 * The HTTP gate and this action both assert that Clerk identity before the
 * internal membership/device query, so minting fails closed if Convex does
 * not forward auth into internals. The runner signing secret remains in
 * Convex/Worker secrets and never reaches the renderer. Capabilities are
 * generation-fenced and cannot provision or destroy computers. The service
 * Bearer (`MIVLET_HOSTED_RUNNER_API_KEY`) is lifecycle-only.
 */
export async function mintExecutionCapability(
  ctx: ConvexAuthReader & {
    runQuery: Function;
  },
  args: {
    workspaceId: string;
    deviceId: string;
    agentId: string;
    scope: HostedExecutionCapabilityScope;
  },
): Promise<HostedExecutionCapabilityReceipt> {
  await requireHttpClerkIdentity(ctx);
  const authorized: { computerId: string; generation: number } = await ctx.runQuery(
    internal.hostedExecution.authorizeExecutionCapability,
    {
      workspaceId: args.workspaceId,
      deviceId: args.deviceId,
      agentId: args.agentId,
    },
  );
  const signingKey = readMivletEnvValue(process.env, "HOSTED_RUNNER_SIGNING_KEY");
  if (!signingKey || signingKey.length < 32) throw new Error("runner-configuration-required");
  const runnerUrl = hostedRunnerBaseUrl(readMivletEnvValue(process.env, "HOSTED_RUNNER_URL")).toString().replace(/\/$/, "");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + EXECUTION_CAPABILITY_LIFETIME_MS;
  const token = await signHostedExecutionCapability(signingKey, {
    version: 1,
    computerId: authorized.computerId,
    generation: authorized.generation,
    scopes: [args.scope],
    issuedAt,
    expiresAt,
    nonce: `cap-${crypto.randomUUID()}`
  });
  return {
    runnerUrl,
    token,
    computerId: authorized.computerId,
    generation: authorized.generation,
    expiresAt
  };
}

export const requestExecutionCapability = internalAction({
  args: executionCapabilityArgs,
  handler: mintExecutionCapability,
});

export const loadProvisionRequest = internalQuery({
  args: { requestId: v.id("hosted_execution_requests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || request.operation !== "provision" || request.status !== "pending") return null;
    return { requestId: args.requestId, computerId: request.computerId };
  }
});

export const recordProvisionResult = internalMutation({
  args: {
    requestId: v.id("hosted_execution_requests"), ok: v.boolean(), errorCode: v.optional(v.string()),
    snapshot: v.optional(v.object({
      computerId: v.string(), lifecycle: v.string(), runtimeActive: v.boolean(), keepAlive: v.boolean(),
      generation: v.number(), updatedAt: v.string()
    }))
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || request.operation !== "provision" || request.status !== "pending") return;
    const nodes = await ctx.db.query("hosted_execution_nodes")
      .withIndex("by_computer", (q) => q.eq("computerId", request.computerId)).collect();
    if (nodes.length !== 1) throw new Error("The hosted execution node is unavailable.");
    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: args.ok ? "completed" : "failed", ...(args.errorCode ? { errorCode: args.errorCode } : {}), updatedAt: now
    });
    const snapshot = args.snapshot;
    await ctx.db.patch(nodes[0]._id, {
      status: args.ok && snapshot?.lifecycle === "ready" ? "ready" : "degraded",
      runtimeActive: snapshot?.runtimeActive ?? false,
      keepAlive: snapshot?.keepAlive ?? false,
      runnerGeneration: snapshot?.generation ?? nodes[0].runnerGeneration,
      revision: nodes[0].revision + 1,
      updatedAt: now
    });
  }
});

export const provisionScheduled = internalAction({
  args: { requestId: v.id("hosted_execution_requests") },
  handler: async (ctx, args) => {
    const request = await ctx.runQuery(internal.hostedExecution.loadProvisionRequest, args);
    if (!request) return;
    let snapshot: HostedComputerSnapshot | undefined;
    let errorCode: string | undefined;
    try {
      const baseUrl = hostedRunnerBaseUrl(readMivletEnvValue(process.env, "HOSTED_RUNNER_URL"));
      const apiKey = readMivletEnvValue(process.env, "HOSTED_RUNNER_API_KEY");
      if (!apiKey || apiKey.length < 32) throw new Error("runner-configuration-required");
      const response = await fetch(new URL(`/v1/computers/${request.computerId}`, baseUrl), {
        method: "PUT",
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const value = await readBoundedJson(response);
      if (!response.ok) throw new Error("runner-request-rejected");
      snapshot = validateHostedComputerSnapshot(value, request.computerId);
    } catch (error) {
      errorCode = safeErrorCode(error);
    }
    await ctx.runMutation(internal.hostedExecution.recordProvisionResult, {
      requestId: args.requestId,
      ok: snapshot?.lifecycle === "ready",
      ...(snapshot ? { snapshot } : {}),
      ...(errorCode ? { errorCode } : {})
    });
  }
});

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.headers.get("content-length") && Number(response.headers.get("content-length")) > MAX_RUNNER_RESPONSE_BYTES) {
    throw new Error("runner-response-invalid");
  }
  if (!response.body) throw new Error("runner-response-invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RUNNER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("runner-response-invalid");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("runner-response-invalid"); }
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "runner-unavailable";
  return /^[a-z0-9-]{1,80}$/.test(message) ? message : "runner-unavailable";
}
