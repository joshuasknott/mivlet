import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireConvexIdentity } from "./convexAuth";

async function authorizeSnapshot(ctx: any, workspaceId: string) {
  const identity = await requireConvexIdentity(ctx);
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .first();
  if (!workspace || workspace.status !== "active" || workspace.clerkOrgId !== identity.orgId) {
    throw new Error("The shared workspace is unavailable.");
  }
  const membership = await ctx.db
    .query("workspace_memberships")
    .withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", workspaceId).eq("clerkUserId", identity.subject))
    .first();
  if (!membership || membership.status !== "active") {
    throw new Error("Active Fable workspace membership is required.");
  }
  return workspace;
}

export const getWorkspaceSnapshot = queryGeneric({
  args: { workspaceId: v.string(), afterRevision: v.number() },
  handler: async (ctx, args) => {
    const workspace = await authorizeSnapshot(ctx, args.workspaceId);
    const projects = await ctx.db
      .query("shared_projects")
      .withIndex("by_workspace_revision", (q: any) =>
        q.eq("workspaceId", args.workspaceId).gt("revision", args.afterRevision)
      )
      .collect();
    const tombstones = await ctx.db
      .query("tombstones")
      .withIndex("by_workspace_revision", (q: any) =>
        q.eq("workspaceId", args.workspaceId).gt("revision", args.afterRevision)
      )
      .collect();
    return { workspaceRevision: workspace.revision, projects, tombstones };
  }
});

export const subscribeWorkspace = queryGeneric({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    await authorizeSnapshot(ctx, args.workspaceId);
    const projects = await ctx.db
      .query("shared_projects")
      .withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return projects.filter((project) => !project.deletedAt);
  }
});
