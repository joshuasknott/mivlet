import {
  verifyHostedExecutionCapability,
  type HostedExecutionCapabilityScope
} from "@fable/protocol";

export async function authorizeCapabilityRequest(
  request: Request,
  rootSecret: string | undefined,
  computerId: string,
  scope: HostedExecutionCapabilityScope
): Promise<{ authorized: boolean; expectedGeneration?: number }> {
  if (await serviceAuthorized(request, rootSecret)) return { authorized: true };
  if (!rootSecret || rootSecret.length < 32) return { authorized: false };
  const value = request.headers.get("Authorization");
  if (!value?.startsWith("FableCapability ")) return { authorized: false };
  try {
    const payload = await verifyHostedExecutionCapability(
      rootSecret,
      value.slice("FableCapability ".length),
      { computerId, scope }
    );
    return { authorized: true, expectedGeneration: payload.generation };
  } catch {
    return { authorized: false };
  }
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
