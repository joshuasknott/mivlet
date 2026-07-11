import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { GenericDataModel } from "convex/server";
import type { CloudIdentity } from "./cloudPolicy";
import { normalizeInvitationEmail } from "./invitationRecipient";

type AuthCtx = GenericQueryCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel>;

export interface ValidatedDisplayProfile {
  displayName?: string;
  emailHint?: string;
}

export interface ConvexAccountIdentity {
  external: CloudIdentity;
  profile?: ValidatedDisplayProfile;
  verifiedEmail?: string;
}

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

function boundedDisplayName(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").replace(CONTROL_OR_FORMAT, "").replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= 120 ? normalized : undefined;
}

function verifiedEmailHint(identity: { [key: string]: unknown }) {
  const verified = identity.emailVerified === true || identity.email_verified === true;
  if (!verified || typeof identity.email !== "string") return undefined;
  const email = identity.email.normalize("NFKC").trim();
  if (!email || email.length > 254 || /[\p{Cc}\p{Cf}\s]/u.test(email)) return undefined;
  const separator = email.lastIndexOf("@");
  if (separator < 1 || separator !== email.indexOf("@")) return undefined;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1).toLowerCase();
  const labels = domain.split(".");
  if (local.length > 64 || domain.length > 253 || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) return undefined;
  const first = Array.from(local)[0];
  return `${/[a-z0-9]/iu.test(first) ? first : "*"}***@${domain}`;
}

/** Display claims are optional, bounded, and never participate in authorization. */
export function validatedDisplayProfile(identity: { [key: string]: unknown }): ValidatedDisplayProfile | undefined {
  const displayName = boundedDisplayName(identity.name) ?? boundedDisplayName(identity.preferredUsername) ?? boundedDisplayName(identity.preferred_username);
  const emailHint = verifiedEmailHint(identity);
  return displayName || emailHint ? { ...(displayName ? { displayName } : {}), ...(emailHint ? { emailHint } : {}) } : undefined;
}

export async function requireConvexAccountIdentity(ctx: AuthCtx): Promise<ConvexAccountIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  const issuer = readStringClaim(identity ?? {}, "issuer") ?? readIssuerFromTokenIdentifier(identity?.tokenIdentifier);
  if (!identity?.subject || !issuer) throw new Error("A validated issuer and subject are required.");
  let verifiedEmail: string | undefined;
  if ((identity?.emailVerified === true || identity?.email_verified === true) && typeof identity.email === "string") {
    try { verifiedEmail = normalizeInvitationEmail(identity.email); } catch { verifiedEmail = undefined; }
  }
  return {
    external: { provider: "clerk", normalizedIssuer: normalizeIssuer(issuer), subject: identity.subject },
    profile: validatedDisplayProfile(identity),
    ...(verifiedEmail ? { verifiedEmail } : {}),
  };
}

/** Extract only validated provider facts; organization claims are intentionally ignored. */
export async function requireConvexIdentity(ctx: AuthCtx): Promise<CloudIdentity> {
  return (await requireConvexAccountIdentity(ctx)).external;
}
function readStringClaim(value: { [key: string]: unknown }, key: string) { const claim = value[key]; return typeof claim === "string" && claim.trim() ? claim : undefined; }
function readIssuerFromTokenIdentifier(tokenIdentifier?: string) { if (!tokenIdentifier) return undefined; const marker = "|"; const index = tokenIdentifier.lastIndexOf(marker); return index > 0 ? tokenIdentifier.slice(0, index) : undefined; }
export function normalizeIssuer(issuer: string) { return issuer.trim().replace(/\/+$/, "").toLowerCase(); }
