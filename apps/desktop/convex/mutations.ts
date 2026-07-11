import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import type { CloudMutationResult, SharedProjectRecord, SharedProjectTombstone } from "@fable/protocol";
import { requireActiveDevice } from "./authorization";

const projectPayload = v.object({
  title: v.optional(v.string()),
  description: v.optional(v.union(v.string(), v.null())),
  instructions: v.optional(v.union(v.string(), v.null()))
});

export function projectRecord(row: any, workspaceRevision = row.revision): SharedProjectRecord {
  return {
    id: row.projectId,
    workspaceId: row.workspaceId,
    authority: "convex",
    visibility: "workspace-shared",
    schemaVersion: 1,
    revision: row.revision,
    workspaceRevision,
    createdByInternalUserId: row.createdByInternalUserId,
    createdByDeviceId: row.createdByDeviceId,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    title: row.name,
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.instructions === undefined ? {} : { instructions: row.instructions }),
    lifecycle: "active"
  } as SharedProjectRecord;
}

export function projectTombstone(row: any): SharedProjectTombstone {
  return {
    workspaceId: row.workspaceId,
    recordType: "project",
    recordId: row.recordId,
    revision: row.revision,
    deletedAt: new Date(row.deletedAt).toISOString(),
    actorInternalUserId: row.actorInternalUserId,
    actorMemberId: row.actorMemberId,
    actorDeviceId: row.actorDeviceId,
    reasonClass: row.reasonClass
  } as SharedProjectTombstone;
}

type RejectionCode = Extract<CloudMutationResult, { status: "rejected" | "conflict" }>["code"];
function rejection(code: RejectionCode, status: "rejected" | "conflict" = "rejected"): CloudMutationResult {
  return { status, code, message: "The shared record is unavailable." } as CloudMutationResult;
}

export function replayedMutation(replay: { intentFingerprint: string; result: CloudMutationResult } | null, fingerprint: string) {
  if (!replay) return null;
  return replay.intentFingerprint === fingerprint ? replay.result : rejection("idempotency-conflict");
}

export function canonicalProjectPayload(operation: "create" | "update" | "delete", payload: any) {
  if (operation === "delete") {
    if (payload !== undefined) throw new Error("Shared project delete cannot carry content.");
    return null;
  }
  const clean = (value: unknown, max: number, allowNull = false) => {
    if (value === undefined || (allowNull && value === null)) return value;
    if (typeof value !== "string") throw new Error("Shared project content is invalid.");
    const normalized = value.trim();
    if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("Shared project content is invalid.");
    return normalized;
  };
  const canonical = {
    ...(payload?.title === undefined ? {} : { title: clean(payload.title, 200) }),
    ...(payload?.description === undefined ? {} : { description: clean(payload.description, 4_000, true) }),
    ...(payload?.instructions === undefined ? {} : { instructions: clean(payload.instructions, 32_000, true) })
  };
  if (operation === "create" && !("title" in canonical)) throw new Error("Shared project create requires a title.");
  if (operation === "create" && (canonical.description === null || canonical.instructions === null)) {
    throw new Error("Shared project create cannot clear missing content.");
  }
  if (operation === "update" && Object.keys(canonical).length === 0) throw new Error("Shared project update has no changes.");
  return canonical;
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function computedFingerprint(args: any, payload: any) {
  const canonical = stableJson({
    workspaceId: args.workspaceId, deviceId: args.deviceId, clientMutationId: args.clientMutationId,
    baseRevision: args.baseRevision, recordType: args.recordType, recordId: args.recordId,
    operation: args.operation, payload
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const applyOutboxMutation = mutationGeneric({
  args: {
    workspaceId: v.string(),
    deviceId: v.string(),
    clientMutationId: v.string(),
    idempotencyKey: v.string(),
    intentFingerprint: v.string(),
    baseRevision: v.number(),
    recordType: v.literal("project"),
    recordId: v.string(),
    operation: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
    payload: v.optional(projectPayload)
  },
  handler: async (ctx, args): Promise<CloudMutationResult> => {
    const now = Date.now();
    let authz: any;
    try {
      authz = await requireActiveDevice(ctx, args.workspaceId, args.deviceId);
      if (authz.membership.role === "viewer") return await store(ctx, args, rejection("permission-denied"), now, authz);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const code = message.includes("membership") ? "membership-inactive" : message.includes("device") ? "device-inactive" : "permission-denied";
      return rejection(code);
    }
    let payload: any;
    try {
      payload = canonicalProjectPayload(args.operation, args.payload);
    } catch {
      return store(ctx, args, rejection("conflict", "conflict"), now, authz);
    }
    const expected = `${args.workspaceId}:${args.deviceId}:${args.clientMutationId}`;
    const replay = await ctx.db.query("idempotency_keys")
      .withIndex("by_mutation", (q: any) => q.eq("workspaceId", args.workspaceId).eq("deviceId", args.deviceId).eq("clientMutationId", args.clientMutationId))
      .first();
    const fingerprintValid = /^[a-f0-9]{64}$/.test(args.intentFingerprint) &&
      await computedFingerprint(args, payload) === args.intentFingerprint;
    if (replay) {
      return fingerprintValid ? replayedMutation(replay as any, args.intentFingerprint)! : rejection("idempotency-conflict");
    }
    if (args.idempotencyKey !== expected || !fingerprintValid) {
      return store(ctx, args, rejection("idempotency-conflict"), now, authz);
    }
    const workspace = authz.workspace;
    const tombstone = await ctx.db.query("tombstones")
      .withIndex("by_record", (q: any) => q.eq("workspaceId", args.workspaceId).eq("recordType", "project").eq("recordId", args.recordId))
      .first();
    const existing = await ctx.db.query("shared_projects")
      .withIndex("by_workspace_record", (q: any) => q.eq("workspaceId", args.workspaceId).eq("projectId", args.recordId))
      .first();
    const conflict = tombstone ||
      (args.operation === "create" && existing && !existing.deletedAt) ||
      (args.operation !== "create" && (!existing || existing.deletedAt || existing.revision !== args.baseRevision));
    if (conflict) {
      const result = rejection(args.operation === "create" ? "conflict" : "stale-revision", "conflict");
      if (existing && !existing.deletedAt) (result as any).currentRecord = projectRecord(existing, workspace.revision);
      return store(ctx, args, result, now, authz);
    }
    const revision = workspace.revision + 1;
    let result: CloudMutationResult;
    if (args.operation === "create") {
      if (!payload.title) return store(ctx, args, rejection("conflict", "conflict"), now, authz);
      const id = await ctx.db.insert("shared_projects", {
        workspaceId: args.workspaceId, projectId: args.recordId, name: payload.title,
        description: payload.description ?? undefined, instructions: payload.instructions ?? undefined,
        revision, createdByInternalUserId: authz.user.internalUserId,
        createdByDeviceId: args.deviceId, createdAt: now, updatedAt: now
      });
      result = { status: "accepted", workspaceRevision: revision, record: projectRecord(await ctx.db.get(id), revision) };
    } else if (args.operation === "update") {
      const patch: any = { revision, updatedAt: now };
      if (payload.title !== undefined) patch.name = payload.title;
      if (payload.description !== undefined) patch.description = payload.description ?? undefined;
      if (payload.instructions !== undefined) patch.instructions = payload.instructions ?? undefined;
      await ctx.db.patch(existing._id, patch);
      result = { status: "accepted", workspaceRevision: revision, record: projectRecord(await ctx.db.get(existing._id), revision) };
    } else {
      await ctx.db.patch(existing._id, { revision, updatedAt: now, deletedAt: now });
      const tombstoneId = await ctx.db.insert("tombstones", {
        workspaceId: args.workspaceId, recordType: "project", recordId: args.recordId,
        revision, deletedAt: now, actorInternalUserId: authz.user.internalUserId,
        actorMemberId: authz.membership.memberId, actorDeviceId: args.deviceId, reasonClass: "user-delete"
      });
      result = { status: "accepted", workspaceRevision: revision, tombstone: projectTombstone(await ctx.db.get(tombstoneId)) };
    }
    await ctx.db.patch(workspace._id, { revision, updatedAt: now });
    return store(ctx, args, result, now, authz);
  }
});

async function store(ctx: any, args: any, result: CloudMutationResult, now: number, authz?: any) {
  await ctx.db.insert("idempotency_keys", {
    workspaceId: args.workspaceId, deviceId: args.deviceId, clientMutationId: args.clientMutationId,
    idempotencyKey: args.idempotencyKey, intentFingerprint: args.intentFingerprint,
    status: result.status === "accepted" ? "accepted" : "rejected", result, createdAt: now
  });
  if (authz) await ctx.db.insert("mutation_audit", {
    workspaceId: args.workspaceId, internalUserId: authz.user.internalUserId,
    memberId: authz.membership.memberId, deviceId: args.deviceId,
    clientMutationId: args.clientMutationId, recordType: "project", recordId: args.recordId,
    operation: args.operation, status: result.status === "accepted" ? "accepted" : "rejected",
    revision: result.status === "accepted" ? result.workspaceRevision : undefined, createdAt: now
  });
  return result;
}
