import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { GenericDataModel } from "convex/server";
import type { CloudIdentity } from "./cloudPolicy";

type AuthCtx = GenericQueryCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel>;

export async function requireConvexIdentity(ctx: AuthCtx): Promise<CloudIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) {
    throw new Error("A valid Clerk identity is required.");
  }
  const orgId =
    readStringClaim(identity, "org_id") ??
    readStringClaim(identity, "orgId") ??
    readStringClaim(identity, "organization_id");
  return { subject: identity.subject, orgId };
}

function readStringClaim(identity: { [key: string]: unknown }, key: string): string | undefined {
  const value = identity[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
