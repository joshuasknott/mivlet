import { describe, expect, it, vi } from "vitest";
import {
  classifyCapabilityHttpFailure,
  handleNativeExecutionCapability,
  parseExecutionCapabilityArgs,
} from "./http";

const VALID_BODY = {
  workspaceId: "workspace_1",
  deviceId: "device_1",
  agentId: "agent_1",
  scope: "process:launch",
};

const CLERK_IDENTITY = {
  subject: "user_clerk",
  issuer: "https://clerk.example",
  tokenIdentifier: "https://clerk.example|user_clerk",
};

const RECEIPT = {
  runnerUrl: "https://runner.example.com",
  token: "v1.payload.sig",
  computerId: "fc-0123456789abcdef",
  generation: 1,
  expiresAt: Date.now() + 60_000,
};

function jsonRequest(body: unknown): Request {
  return new Request("https://deployment.convex.site/native/execution-capability", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(options: {
  identity?: { [key: string]: unknown } | null;
  identityError?: Error;
  mint?: (ref: unknown, args: unknown) => Promise<unknown>;
}) {
  const runAction = vi.fn(options.mint ?? (async () => RECEIPT));
  return {
    ctx: {
      auth: {
        getUserIdentity: async () => {
          if (options.identityError) throw options.identityError;
          return options.identity === undefined ? CLERK_IDENTITY : options.identity;
        },
      },
      runAction,
    },
    runAction,
  };
}

async function read(response: Response) {
  return {
    status: response.status,
    body: (await response.json()) as { status: string; errorMessage?: string; value?: unknown },
  };
}

describe("native execution-capability HTTP auth", () => {
  it("rejects a missing Clerk identity with 401 and does not mint", async () => {
    const { ctx: httpCtx, runAction } = ctx({ identity: null });
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result).toEqual({
      status: 401,
      body: { status: "error", errorMessage: "authentication-required" },
    });
    expect(runAction).not.toHaveBeenCalled();
  });

  it("rejects a thrown HTTP identity lookup with 401 and does not mint", async () => {
    const { ctx: httpCtx, runAction } = ctx({
      identityError: new Error("No auth header provided"),
    });
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result.status).toBe(401);
    expect(result.body.errorMessage).toBe("authentication-required");
    expect(runAction).not.toHaveBeenCalled();
  });

  it("rejects an identity without issuer and subject", async () => {
    const { ctx: httpCtx, runAction } = ctx({
      identity: { name: "not-enough" },
    });
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result.status).toBe(401);
    expect(result.body.errorMessage).toBe("authentication-required");
    expect(runAction).not.toHaveBeenCalled();
  });

  it("does not parse the body until Clerk identity is present", async () => {
    const { ctx: httpCtx, runAction } = ctx({ identity: null });
    const result = await read(
      await handleNativeExecutionCapability(
        httpCtx,
        new Request("https://deployment.convex.site/native/execution-capability", {
          method: "POST",
          body: "not-json",
        }),
      ),
    );
    expect(result.status).toBe(401);
    expect(runAction).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON after a valid Clerk session", async () => {
    const { ctx: httpCtx, runAction } = ctx({});
    const result = await read(
      await handleNativeExecutionCapability(
        httpCtx,
        new Request("https://deployment.convex.site/native/execution-capability", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
    );
    expect(result).toEqual({
      status: 400,
      body: { status: "error", errorMessage: "invalid-request" },
    });
    expect(runAction).not.toHaveBeenCalled();
  });

  it("rejects an authenticated request with an unknown scope", async () => {
    const { ctx: httpCtx, runAction } = ctx({});
    const result = await read(
      await handleNativeExecutionCapability(
        httpCtx,
        jsonRequest({ ...VALID_BODY, scope: "host:shell" }),
      ),
    );
    expect(result.status).toBe(400);
    expect(result.body.errorMessage).toBe("invalid-request");
    expect(runAction).not.toHaveBeenCalled();
  });

  it("mints through the internal action when Clerk identity is present", async () => {
    const { ctx: httpCtx, runAction } = ctx({});
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result).toEqual({
      status: 200,
      body: { status: "success", value: RECEIPT },
    });
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]?.[1]).toEqual(VALID_BODY);
    expect(typeof runAction.mock.calls[0]?.[0]).toBe("object");
  });

  it("maps a nested mint authentication failure to 401", async () => {
    const { ctx: httpCtx, runAction } = ctx({
      mint: async () => {
        throw new Error("authentication-required");
      },
    });
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result).toEqual({
      status: 401,
      body: { status: "error", errorMessage: "authentication-required" },
    });
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("maps membership denial to 403 instead of a generic 400", async () => {
    const { ctx: httpCtx } = ctx({
      mint: async () => {
        throw new Error("Active Mivlet workspace membership is required.");
      },
    });
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result).toEqual({
      status: 403,
      body: { status: "error", errorMessage: "membership-required" },
    });
  });

  it("maps a wrapped Convex device denial to 403 device-required", async () => {
    const { ctx: httpCtx } = ctx({
      mint: async () => {
        throw new Error(
          "[CONVEX A(hostedExecution:requestExecutionCapability)] Server Error\nUncaught Error: An active Mivlet device link is required.",
        );
      },
    });
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result).toEqual({
      status: 403,
      body: { status: "error", errorMessage: "device-required" },
    });
  });

  it("maps an unready hosted computer to 409", async () => {
    const { ctx: httpCtx } = ctx({
      mint: async () => {
        throw new Error("The hosted computer is not ready.");
      },
    });
    const result = await read(
      await handleNativeExecutionCapability(httpCtx, jsonRequest(VALID_BODY)),
    );
    expect(result.status).toBe(409);
    expect(result.body.errorMessage).toBe("computer-not-ready");
  });
});

describe("capability HTTP argument and error classification", () => {
  it("accepts only the native capability scopes", () => {
    expect(parseExecutionCapabilityArgs(VALID_BODY).scope).toBe("process:launch");
    expect(() => parseExecutionCapabilityArgs({ ...VALID_BODY, scope: "os:exec" })).toThrow(
      "invalid-request",
    );
  });

  it("classifies auth and configuration failures without leaking internals", () => {
    expect(classifyCapabilityHttpFailure(new Error("authentication-required"))).toEqual({
      status: 401,
      errorMessage: "authentication-required",
    });
    expect(
      classifyCapabilityHttpFailure(
        new Error("This Mivlet role is not permitted for the requested operation."),
      ),
    ).toEqual({ status: 403, errorMessage: "role-not-permitted" });
    expect(classifyCapabilityHttpFailure(new Error("runner-configuration-required"))).toEqual({
      status: 503,
      errorMessage: "runner-configuration-required",
    });
    expect(classifyCapabilityHttpFailure(new Error("HMAC key dump: secret-value"))).toEqual({
      status: 400,
      errorMessage: "capability-unavailable",
    });
  });
});
