import type { IsoDateTime } from "./primitives.js";

/**
 * Roles recognized by the optional hosted-computer service. They grant no
 * authority over local conversations, provider credentials, or local tools.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export interface ExternalIdentityKey {
  provider: string;
  normalizedIssuer: string;
  subject: string;
}

export const VERIFIED_IDENTITY_ATTRIBUTE_KINDS = ["email", "phone"] as const;
export type VerifiedIdentityAttributeKind =
  (typeof VERIFIED_IDENTITY_ATTRIBUTE_KINDS)[number];

export interface VerifiedIdentityAttribute {
  kind: VerifiedIdentityAttributeKind;
  normalizedValueHash: string;
  verifiedAt: IsoDateTime;
}

/**
 * Validated provider facts identify an optional account principal. They never
 * authorize installation-local product data or provider execution.
 */
export interface ExternalAuthenticationFacts extends ExternalIdentityKey {
  authenticationEventRef: string;
  sessionRef: string;
  authenticatedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  verifiedAttributes: readonly VerifiedIdentityAttribute[];
}
