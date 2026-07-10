import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { GenericDataModel } from "convex/server";
import type { CloudIdentity } from "./cloudPolicy";

type AuthCtx = GenericQueryCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel>;

/** Extract only validated provider facts; organization claims are intentionally ignored. */
export async function requireConvexIdentity(ctx: AuthCtx): Promise<CloudIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  const issuer = readStringClaim(identity ?? {}, "issuer") ?? readIssuerFromTokenIdentifier(identity?.tokenIdentifier);
  if (!identity?.subject || !issuer) throw new Error("A validated issuer and subject are required.");
  return { provider: "clerk", normalizedIssuer: normalizeIssuer(issuer), subject: identity.subject };
}
function readStringClaim(value: { [key: string]: unknown }, key: string) { const claim = value[key]; return typeof claim === "string" && claim.trim() ? claim : undefined; }
function readIssuerFromTokenIdentifier(tokenIdentifier?: string) { if (!tokenIdentifier) return undefined; const marker = "|"; const index = tokenIdentifier.lastIndexOf(marker); return index > 0 ? tokenIdentifier.slice(0, index) : undefined; }
export function normalizeIssuer(issuer: string) { return issuer.trim().replace(/\/+$/, "").toLowerCase(); }
