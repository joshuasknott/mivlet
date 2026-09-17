import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireHttpClerkIdentity, type ConvexAuthReader } from "./convexAuth";
import {
  EXECUTION_CAPABILITY_MINT_WINDOW_MS,
  RATE_LIMITED_CODE,
} from "./executionCapabilityMintRate";

const EXECUTION_CAPABILITY_SCOPES = [
  "process:launch",
  "process:inspect",
  "process:kill",
  "browser:navigate",
  "browser:act",
  "browser:snapshot",
] as const;

type ExecutionCapabilityScope = (typeof EXECUTION_CAPABILITY_SCOPES)[number];

const AUTHENTICATION_CODE = "authentication-required";

const KNOWN_FAILURES: ReadonlyArray<{
  match: string;
  status: number;
  errorMessage: string;
}> = [
  { match: "A validated issuer and subject are required.", status: 401, errorMessage: AUTHENTICATION_CODE },
  { match: AUTHENTICATION_CODE, status: 401, errorMessage: AUTHENTICATION_CODE },
  { match: "Mivlet identity link is ambiguous.", status: 403, errorMessage: "identity-link-ambiguous" },
  { match: "Mivlet identity link is unavailable.", status: 403, errorMessage: "identity-link-unavailable" },
  { match: "Mivlet account is unavailable.", status: 403, errorMessage: "account-unavailable" },
  { match: "The requested workspace is unavailable.", status: 403, errorMessage: "workspace-unavailable" },
  { match: "Active Mivlet workspace membership is required.", status: 403, errorMessage: "membership-required" },
  { match: "An active Mivlet device link is required.", status: 403, errorMessage: "device-required" },
  { match: "This Mivlet role is not permitted for the requested operation.", status: 403, errorMessage: "role-not-permitted" },
  { match: "The hosted computer is not ready.", status: 409, errorMessage: "computer-not-ready" },
  { match: "The hosted execution node is unavailable.", status: 409, errorMessage: "computer-unavailable" },
  { match: "invalid-request", status: 400, errorMessage: "invalid-request" },
  { match: "runner-configuration-required", status: 503, errorMessage: "runner-configuration-required" },
  { match: "runner-configuration-invalid", status: 503, errorMessage: "runner-configuration-invalid" },
  { match: RATE_LIMITED_CODE, status: 429, errorMessage: RATE_LIMITED_CODE },
];

const KEBAB_STATUS: Record<string, number> = {
  [AUTHENTICATION_CODE]: 401,
  "identity-link-ambiguous": 403,
  "identity-link-unavailable": 403,
  "account-unavailable": 403,
  "workspace-unavailable": 403,
  "membership-required": 403,
  "device-required": 403,
  "role-not-permitted": 403,
  "computer-not-ready": 409,
  "computer-unavailable": 409,
  "runner-configuration-required": 503,
  "runner-configuration-invalid": 503,
  "invalid-request": 400,
  [RATE_LIMITED_CODE]: 429,
};

export type ExecutionCapabilityHttpCtx = ConvexAuthReader & {
  runAction: Function;
  runMutation: Function;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseExecutionCapabilityArgs(value: unknown): {
  workspaceId: string;
  deviceId: string;
  agentId: string;
  scope: ExecutionCapabilityScope;
} {
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== "string" ||
    typeof value.deviceId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.scope !== "string" ||
    !EXECUTION_CAPABILITY_SCOPES.includes(
      value.scope as ExecutionCapabilityScope,
    )
  ) {
    throw new Error("invalid-request");
  }
  return {
    workspaceId: value.workspaceId,
    deviceId: value.deviceId,
    agentId: value.agentId,
    scope: value.scope as ExecutionCapabilityScope,
  };
}

function rawErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "capability-unavailable";
}

/** Map Convex/auth failures to a stable kebab-case code and HTTP status. */
export function classifyCapabilityHttpFailure(error: unknown): {
  status: number;
  errorMessage: string;
} {
  const raw = rawErrorText(error);
  for (const known of KNOWN_FAILURES) {
    if (raw === known.match || raw.includes(known.match)) {
      return { status: known.status, errorMessage: known.errorMessage };
    }
  }
  if (/^[a-z0-9-]{1,80}$/.test(raw)) {
    return { status: KEBAB_STATUS[raw] ?? 400, errorMessage: raw };
  }
  return { status: 400, errorMessage: "capability-unavailable" };
}

function jsonError(
  status: number,
  errorMessage: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { status: "error", errorMessage },
    headers ? { status, headers } : { status },
  );
}

function rateLimitedResponse(): Response {
  return jsonError(429, RATE_LIMITED_CODE, {
    "Retry-After": String(Math.ceil(EXECUTION_CAPABILITY_MINT_WINDOW_MS / 1000)),
  });
}

/**
 * Native-only capability mint. Clerk identity is asserted here before the
 * internal action so a missing or invalid session is 401 (native clears the
 * OS-keyring session) rather than a generic 400. After identity and a valid
 * body, a per-subject and per-subject+device mint window is consumed; excess
 * mints fail closed as 429 `rate-limited` and never call the mint action.
 */
export async function handleNativeExecutionCapability(
  ctx: ExecutionCapabilityHttpCtx,
  request: Request,
): Promise<Response> {
  try {
    await requireHttpClerkIdentity(ctx);
  } catch (error) {
    const failure = classifyCapabilityHttpFailure(error);
    return jsonError(failure.status, failure.errorMessage);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid-request");
  }

  try {
    const args = parseExecutionCapabilityArgs(body);
    await ctx.runMutation(internal.hostedExecution.consumeExecutionCapabilityMint, {
      deviceId: args.deviceId,
    });
    const receipt = await ctx.runAction(
      internal.hostedExecution.requestExecutionCapability,
      args,
    );
    return Response.json({ status: "success", value: receipt });
  } catch (error) {
    const failure = classifyCapabilityHttpFailure(error);
    if (failure.errorMessage === RATE_LIMITED_CODE) return rateLimitedResponse();
    return jsonError(failure.status, failure.errorMessage);
  }
}

const http = httpRouter();

http.route({
  path: "/native/execution-capability",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    handleNativeExecutionCapability(ctx, request),
  ),
});

export default http;
