/** Queries, mutations, actions, and HTTP actions all expose `ctx.auth`. */
export type ConvexAuthReader = {
  auth: {
    getUserIdentity: () => Promise<null | {
      subject?: unknown;
      issuer?: unknown;
      tokenIdentifier?: unknown;
      [key: string]: unknown;
    }>;
  };
};

export interface CloudIdentity {
  provider: string;
  normalizedIssuer: string;
  subject: string;
}

export interface ValidatedDisplayProfile {
  displayName?: string;
  emailHint?: string;
}

export interface ConvexAccountIdentity {
  external: CloudIdentity;
  profile?: ValidatedDisplayProfile;
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

/**
 * Convex HTTP actions throw from `getUserIdentity` when the Bearer JWT is
 * missing or invalid; queries, mutations, and actions return `null`. Both
 * become the same fail-closed identity error.
 */
export async function requireConvexAccountIdentity(ctx: ConvexAuthReader): Promise<ConvexAccountIdentity> {
  let identity: { [key: string]: unknown } | null;
  try {
    identity = await ctx.auth.getUserIdentity();
  } catch {
    throw new Error("A validated issuer and subject are required.");
  }
  const issuer = readStringClaim(identity ?? {}, "issuer") ?? readIssuerFromTokenIdentifier(
    typeof identity?.tokenIdentifier === "string" ? identity.tokenIdentifier : undefined,
  );
  if (!identity?.subject || typeof identity.subject !== "string" || !issuer) {
    throw new Error("A validated issuer and subject are required.");
  }
  return {
    external: { provider: "clerk", normalizedIssuer: normalizeIssuer(issuer), subject: identity.subject },
    profile: validatedDisplayProfile(identity),
  };
}

/**
 * HTTP/native mint path. Same Clerk facts as `requireConvexAccountIdentity`,
 * with a stable kebab-case code so the HTTP gate can return 401 instead of a
 * generic capability failure.
 */
export async function requireHttpClerkIdentity(ctx: ConvexAuthReader): Promise<ConvexAccountIdentity> {
  try {
    return await requireConvexAccountIdentity(ctx);
  } catch (error) {
    if (error instanceof Error && error.message === "A validated issuer and subject are required.") {
      throw new Error("authentication-required");
    }
    throw error;
  }
}

/** Extract only validated provider facts; organization claims are intentionally ignored. */
export async function requireConvexIdentity(ctx: ConvexAuthReader): Promise<CloudIdentity> {
  return (await requireConvexAccountIdentity(ctx)).external;
}
function readStringClaim(value: { [key: string]: unknown }, key: string) { const claim = value[key]; return typeof claim === "string" && claim.trim() ? claim : undefined; }
function readIssuerFromTokenIdentifier(tokenIdentifier?: string) { if (!tokenIdentifier) return undefined; const marker = "|"; const index = tokenIdentifier.lastIndexOf(marker); return index > 0 ? tokenIdentifier.slice(0, index) : undefined; }
export function normalizeIssuer(issuer: string) { return issuer.trim().replace(/\/+$/, "").toLowerCase(); }
