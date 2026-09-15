import {
  assertHostedExecutionCapability,
  readHostedExecutionCapability,
  type HostedExecutionCapabilityScope
} from "@mivlet/protocol";

export interface CapabilityNonceStore {
  consume(input: { nonce: string; generation: number; expiresAt: number }): Promise<void>;
}

export async function authorizeCapabilityRequest(
  request: Request,
  signingKey: string | undefined,
  computerId: string,
  scope: HostedExecutionCapabilityScope,
  nonceStore: CapabilityNonceStore
): Promise<{ authorized: boolean; expectedGeneration?: number }> {
  const token = capabilityAuthorizationToken(request.headers.get("Authorization"));
  if (!token) return { authorized: false };
  if (!signingKey || signingKey.length < 32) return { authorized: false };
  try {
    const payload = await readHostedExecutionCapability(signingKey, token);
    assertHostedExecutionCapability(payload, {
      computerId,
      scope,
      generation: payload.generation
    });
    await nonceStore.consume({
      nonce: payload.nonce,
      generation: payload.generation,
      expiresAt: payload.expiresAt
    });
    return { authorized: true, expectedGeneration: payload.generation };
  } catch (error) {
    if (isCapabilityCredentialError(error)) return { authorized: false };
    throw error;
  }
}

const CAPABILITY_SCHEMES = [
  "MivletCapability ",
  // Deprecated: former product Authorization scheme.
  "FableCapability "
] as const;

function capabilityAuthorizationToken(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const prefix of CAPABILITY_SCHEMES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return undefined;
}

export async function serviceAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  const value = request.headers.get("Authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const provided = value.slice("Bearer ".length);
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const timingSafeEqual = Reflect.get(crypto.subtle, "timingSafeEqual");
  if (typeof timingSafeEqual !== "function") return false;
  return Reflect.apply(timingSafeEqual, crypto.subtle, [providedHash, expectedHash]) === true;
}

function isCapabilityCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "invalid-capability"
    || error.message === "capability-rejected"
    || error.message === "capability-configuration-required";
}
