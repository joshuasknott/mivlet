import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const EXECUTION_CAPABILITY_SCOPES = [
  "process:launch",
  "process:inspect",
  "process:kill",
  "browser:navigate",
  "browser:act",
  "browser:snapshot"
] as const;

type ExecutionCapabilityScope = (typeof EXECUTION_CAPABILITY_SCOPES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseExecutionCapabilityArgs(value: unknown): {
  workspaceId: string;
  deviceId: string;
  agentId: string;
  scope: ExecutionCapabilityScope;
} {
  if (
    !isRecord(value)
    || typeof value.workspaceId !== "string"
    || typeof value.deviceId !== "string"
    || typeof value.agentId !== "string"
    || typeof value.scope !== "string"
    || !EXECUTION_CAPABILITY_SCOPES.includes(value.scope as ExecutionCapabilityScope)
  ) {
    throw new Error("invalid-request");
  }
  return {
    workspaceId: value.workspaceId,
    deviceId: value.deviceId,
    agentId: value.agentId,
    scope: value.scope as ExecutionCapabilityScope
  };
}

const http = httpRouter();

http.route({
  path: "/native/execution-capability",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ status: "error", errorMessage: "invalid-request" }, { status: 400 });
    }
    try {
      const args = parseExecutionCapabilityArgs(body);
      const receipt = await ctx.runAction(internal.hostedExecution.requestExecutionCapability, args);
      return Response.json({ status: "success", value: receipt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "capability-unavailable";
      const errorMessage = /^[a-z0-9-]{1,80}$/.test(message) ? message : "capability-unavailable";
      return Response.json({ status: "error", errorMessage }, { status: 400 });
    }
  })
});

export default http;
