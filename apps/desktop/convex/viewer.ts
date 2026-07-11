import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import type { CloudWorkspaceDelta, CloudWorkspaceDeltaChange } from "@fable/protocol";
import { requireActiveMembership } from "./authorization";
import { projectRecord, projectTombstone, requireCompleteSharedHistory } from "./mutations";

export function workspaceDelta(
  workspaceId: string,
  afterRevision: number,
  workspaceRevision: number,
  projects: readonly any[],
  tombstones: readonly any[]
): CloudWorkspaceDelta {
  if (!Number.isInteger(afterRevision) || afterRevision < 0 || afterRevision > workspaceRevision) {
    throw new Error("The shared workspace cursor is unavailable.");
  }
  const changes: CloudWorkspaceDeltaChange[] = [
    ...projects.filter((row) => !row.deletedAt).map((row) => ({ kind: "record" as const, record: projectRecord(row, row.revision) })),
    ...tombstones.map((row) => ({ kind: "tombstone" as const, tombstone: projectTombstone(row) }))
  ].sort((left, right) => {
    const a = left.kind === "record" ? left.record.revision : left.tombstone.revision;
    const b = right.kind === "record" ? right.record.revision : right.tombstone.revision;
    return a - b;
  });
  const revisions = changes.map((change) => change.kind === "record" ? change.record.revision : change.tombstone.revision);
  if (new Set(revisions).size !== revisions.length || revisions.some((revision) => revision <= afterRevision || revision > workspaceRevision)) {
    throw new Error("The shared workspace delta is ambiguous.");
  }
  // Workspace revision is the shared-record stream. Any future shared record
  // type must be emitted here; skipping it would create an unsafe cursor gap.
  const expected = Array.from({ length: workspaceRevision - afterRevision }, (_, index) => afterRevision + index + 1);
  if (revisions.length !== expected.length || revisions.some((revision, index) => revision !== expected[index])) {
    throw new Error("The shared workspace delta is not contiguous.");
  }
  return {
    workspaceId: workspaceId as CloudWorkspaceDelta["workspaceId"],
    afterRevision,
    workspaceRevision,
    changes,
  };
}

export const getWorkspaceDelta = queryGeneric({
  args: { workspaceId: v.string(), afterRevision: v.number() },
  handler: async (ctx, args) => {
    const { workspace } = await requireActiveMembership(ctx, args.workspaceId);
    if (!Number.isInteger(args.afterRevision) || args.afterRevision < 0 || args.afterRevision > workspace.revision) {
      throw new Error("The shared workspace cursor is unavailable.");
    }
    const history = await requireCompleteSharedHistory(ctx, workspace, args.afterRevision);
    return {
      workspaceId: args.workspaceId,
      afterRevision: args.afterRevision,
      workspaceRevision: workspace.revision,
      changes: history.filter((row: any) => row.revision > args.afterRevision).map((row: any) => row.change)
    } as CloudWorkspaceDelta;
  }
});

export const subscribeWorkspace = queryGeneric({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    await requireActiveMembership(ctx, args.workspaceId);
    const rows = await ctx.db.query("shared_projects")
      .withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return rows.filter((row: any) => !row.deletedAt).map((row: any) => projectRecord(row, row.revision));
  }
});
