import { requireConvexIdentity } from "./convexAuth";

export async function requireFableUser(ctx: any) {
  const external = await requireConvexIdentity(ctx);
  const link = await ctx.db.query("external_identity_links").withIndex("by_external_identity", (q: any) => q.eq("provider", external.provider).eq("normalizedIssuer", external.normalizedIssuer).eq("subject", external.subject)).first();
  if (!link || link.status !== "active") throw new Error("Fable identity link is unavailable.");
  const user = await ctx.db.query("internal_users").withIndex("by_internal_user", (q: any) => q.eq("internalUserId", link.internalUserId)).first();
  if (!user || user.status !== "active") throw new Error("Fable account is unavailable.");
  return { external, link, user };
}

export async function requireActiveMembership(ctx: any, workspaceId: string) {
  const principal = await requireFableUser(ctx);
  const workspace = await ctx.db.query("workspaces").withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId)).first();
  if (!workspace || workspace.status !== "active") throw new Error("The requested workspace is unavailable.");
  const membership = await ctx.db.query("workspace_memberships").withIndex("by_workspace_user", (q: any) => q.eq("workspaceId", workspaceId).eq("internalUserId", principal.user.internalUserId)).first();
  if (!membership || membership.status !== "active") throw new Error("Active Fable workspace membership is required.");
  return { ...principal, workspace, membership };
}

export async function requireActiveDevice(ctx: any, workspaceId: string, deviceId: string) {
  const authz = await requireActiveMembership(ctx, workspaceId);
  const device = await ctx.db.query("account_devices").withIndex("by_device", (q: any) => q.eq("deviceId", deviceId)).first();
  const link = await ctx.db.query("workspace_device_links").withIndex("by_workspace_device", (q: any) => q.eq("workspaceId", workspaceId).eq("deviceId", deviceId)).first();
  if (!device || device.internalUserId !== authz.user.internalUserId || device.status !== "active" || !link || link.internalUserId !== authz.user.internalUserId || link.memberId !== authz.membership.memberId || link.status !== "active") throw new Error("An active Fable device link is required.");
  return { ...authz, device, link };
}

export function requireRole(role: string, allowed: readonly string[]) { if (!allowed.includes(role)) throw new Error("This Fable role is not permitted for the requested operation."); }
