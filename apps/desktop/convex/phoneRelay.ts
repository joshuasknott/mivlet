import {
  derivePhoneRelayConnectionId,
  readMivletEnvValue,
  signPhoneRelayCapability,
} from "@mivlet/protocol";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import { requireActiveDevice } from "./authorization";
import { requireHttpClerkIdentity, type ConvexAuthReader } from "./convexAuth";
import { hostedRunnerBaseUrl } from "./hostedExecutionPolicy";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
export interface PhoneRelayCapabilityArgs {
  workspaceId: string;
  deviceId: string;
  epoch: string;
}

/** Only the native device's identifiers reach Convex, never a phone session. */
export function parsePhoneRelayCapabilityArgs(value: unknown): PhoneRelayCapabilityArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-request");
  const args = value as Record<string, unknown>;
  if (Object.keys(args).sort().join(",") !== "deviceId,epoch,workspaceId"
    || ![args.workspaceId, args.deviceId].every(id => typeof id === "string" && ID.test(id))
    || typeof args.epoch !== "string" || !/^[a-f0-9]{32}$/.test(args.epoch)) {
    throw new Error("invalid-request");
  }
  return value as PhoneRelayCapabilityArgs;
}

export const authorizePhoneRelayCapability = internalQuery({
  args: { workspaceId: v.string(), deviceId: v.string() },
  returns: v.object({ accountId: v.string() }),
  handler: async (ctx, args) => {
    if (![args.workspaceId, args.deviceId].every(id => ID.test(id))) throw new Error("invalid-request");
    // A relay grants transport only. Existing native per-browser grants and Work
    // authorization still govern reads and writes, including read-only members.
    const authz = await requireActiveDevice(ctx, args.workspaceId, args.deviceId);
    const accountId: unknown = authz.user.internalUserId;
    if (typeof accountId !== "string" || !ID.test(accountId)) throw new Error("account-unavailable");
    return { accountId };
  },
});

export async function mintPhoneRelayCapability(
  ctx: ConvexAuthReader & { runQuery: Function },
  value: PhoneRelayCapabilityArgs,
) {
  await requireHttpClerkIdentity(ctx);
  const args = parsePhoneRelayCapabilityArgs(value);
  const { accountId }: { accountId: string } = await ctx.runQuery(
    internal.phoneRelay.authorizePhoneRelayCapability,
    { workspaceId: args.workspaceId, deviceId: args.deviceId },
  );
  const key = readMivletEnvValue(process.env, "PHONE_RELAY_SIGNING_KEY");
  if (!key || key.length < 32) throw new Error("runner-configuration-required");
  const relayUrl = hostedRunnerBaseUrl(readMivletEnvValue(process.env, "PHONE_RELAY_URL"))
    .toString().replace(/\/$/, "");
  // Server-derived route identity prevents another account from reclaiming a
  // known, expired public URL after its Durable Object metadata is reclaimed.
  const connectionId = await derivePhoneRelayConnectionId(key, { accountId, ...args });
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 120_000;
  const sessionExpiresAt = issuedAt + 8 * 60 * 60_000;
  const token = await signPhoneRelayCapability(key, {
    version: 1, scope: "phone:connect", accountId, ...args, connectionId,
    issuedAt, expiresAt, sessionExpiresAt,
    nonce: `phone-cap-${crypto.randomUUID()}`,
  });
  return { connectionId, relayUrl, token, expiresAt, sessionExpiresAt };
}

/** Native HTTP only; capabilities are never exposed by the public Convex API. */
export const requestPhoneRelayCapability = internalAction({
  args: { workspaceId: v.string(), deviceId: v.string(), epoch: v.string() },
  returns: v.object({ connectionId: v.string(), relayUrl: v.string(), token: v.string(), expiresAt: v.number(), sessionExpiresAt: v.number() }),
  handler: mintPhoneRelayCapability,
});
