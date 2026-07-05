import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireConvexIdentity } from "./convexAuth";

export const list = queryGeneric({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireConvexIdentity(ctx);
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId))
      .first();
    if (!workspace || workspace.status !== "active" || workspace.clerkOrgId !== identity.orgId) {
      throw new Error("The shared workspace is unavailable.");
    }
    const membership = await ctx.db
      .query("workspace_memberships")
      .withIndex("by_workspace_user", (q: any) =>
        q.eq("workspaceId", args.workspaceId).eq("clerkUserId", identity.subject)
      )
      .first();
    if (!membership || membership.status !== "active") {
      throw new Error("Active Fable workspace membership is required.");
    }
    return ctx.db
      .query("workspace_memberships")
      .withIndex("by_workspace", (q: any) => q.eq("workspaceId", args.workspaceId))
      .collect();
  }
});
