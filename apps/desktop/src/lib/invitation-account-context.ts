export interface InvitationAccountContext {
  provider?: string;
  normalizedIssuer?: string;
  subject?: string;
  identityState: string;
  internalUserId?: string;
  accountState: string;
}

/** Collision-safe account identity; workspace selection is intentionally absent. */
export function invitationAccountContextKey(context: InvitationAccountContext) {
  return JSON.stringify([
    context.provider ?? "no-provider",
    context.normalizedIssuer ?? "no-issuer",
    context.subject ?? "signed-out",
    context.identityState,
    context.internalUserId ?? "unbound",
    context.accountState
  ]);
}
