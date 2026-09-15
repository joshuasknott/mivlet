import { Sandbox } from "@cloudflare/sandbox";
import {
  type HostedExecutionCapabilityScope,
  type HostedProcessLaunchRequest
} from "@fable/protocol";
import {
  HostedRunnerRequestError,
  validateComputerId,
  validateLaunchRequest,
  validateProcessId
} from "./contracts";
import { BrowserAuthority } from "./browser-authority";
import { ComputerAuthority } from "./computer-authority";
import { authorizeCapabilityRequest, serviceAuthorized } from "./request-auth";

export { BrowserAuthority, ComputerAuthority, Sandbox };

const MAX_BODY_BYTES = 64 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    let route = "unmatched";
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        route = "health";
        return json({ status: "ok", service: "fable-hosted-runner" });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1" || parts[1] !== "computers" || !parts[2]) {
        return json({ error: "not-found" }, 404);
      }
      const computerId = validateComputerId(parts[2]);
      const authority = env.COMPUTER_AUTHORITY.getByName(computerId);
      const capabilityScope = requestedCapabilityScope(parts, request.method);
      const authorization = capabilityScope
        ? await authorizeCapabilityRequest(
          request,
          env.FABLE_HOSTED_RUNNER_SIGNING_KEY,
          computerId,
          capabilityScope,
          {
            consume: (input) => authority.consumeCapabilityNonce(
              computerId,
              input.nonce,
              input.generation,
              input.expiresAt
            )
          }
        )
        : { authorized: await serviceAuthorized(request, env.FABLE_HOSTED_RUNNER_API_KEY) };
      if (!authorization.authorized) {
        route = "unauthorized";
        return json({ error: "unauthorized" }, 401);
      }
      if (capabilityScope && authorization.expectedGeneration === undefined) {
        route = "unauthorized";
        return json({ error: "unauthorized" }, 401);
      }
      if (parts.length === 3 && request.method === "PUT") {
        route = "computer.ensure";
        return json(await authority.ensure(computerId));
      }
      if (parts.length === 3 && request.method === "GET") {
        route = "computer.status";
        return json(await authority.status(computerId));
      }
      if (parts.length === 3 && request.method === "DELETE") {
        route = "computer.destroy";
        const browser = env.BROWSER_AUTHORITY.getByName(computerId);
        const [, snapshot] = await Promise.all([browser.destroy(computerId), authority.destroy(computerId)]);
        return json(snapshot);
      }
      if (parts[3] === "browser") {
        if (authorization.expectedGeneration === undefined) {
          route = "unauthorized";
          return json({ error: "unauthorized" }, 401);
        }
        const generation = await authority.requireReady(computerId, authorization.expectedGeneration);
        const browser = env.BROWSER_AUTHORITY.getByName(computerId);
        if (parts.length === 5 && parts[4] === "navigate" && request.method === "POST") {
          route = "browser.navigate";
          return json(await browser.navigate(computerId, await readBoundedJson(request), generation));
        }
        if (parts.length === 5 && parts[4] === "act" && request.method === "POST") {
          route = "browser.act";
          return json(await browser.act(computerId, await readBoundedJson(request), generation));
        }
        if (parts.length === 5 && parts[4] === "snapshot" && request.method === "GET") {
          route = "browser.snapshot";
          return json(await browser.snapshot(computerId, generation));
        }
        return json({ error: "not-found" }, 404);
      }
      if (parts[3] !== "processes") return json({ error: "not-found" }, 404);
      if (parts.length === 4 && request.method === "POST") {
        route = "process.launch";
        if (authorization.expectedGeneration === undefined) {
          return json({ error: "unauthorized" }, 401);
        }
        const launch = validateLaunchRequest(await readBoundedJson(request)) satisfies HostedProcessLaunchRequest;
        return json(await authority.launch(computerId, launch, authorization.expectedGeneration), 202);
      }
      if (!parts[4]) return json({ error: "not-found" }, 404);
      const processId = validateProcessId(parts[4]);
      if (parts.length === 5 && request.method === "GET") {
        route = "process.inspect";
        if (authorization.expectedGeneration === undefined) {
          return json({ error: "unauthorized" }, 401);
        }
        return json(await authority.inspect(computerId, processId, authorization.expectedGeneration));
      }
      if (parts.length === 6 && parts[5] === "kill" && request.method === "POST") {
        route = "process.kill";
        if (authorization.expectedGeneration === undefined) {
          return json({ error: "unauthorized" }, 401);
        }
        return json(await authority.kill(computerId, processId, authorization.expectedGeneration), 202);
      }
      return json({ error: "not-found" }, 404);
    } catch (error) {
      if (error instanceof HostedRunnerRequestError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      const code = safeOperationCode(error);
      const status = code === "process-not-found" || code === "computer-not-found" ? 404
        : code === "computer-not-ready" || code === "capability-stale" || code === "capability-replayed" ? 409
        : 503;
      console.error(JSON.stringify({ level: "error", message: "hosted runner request failed", requestId, route, code }));
      return json({ error: code }, status);
    } finally {
      console.log(JSON.stringify({
        level: "info",
        message: "hosted runner request completed",
        requestId,
        route,
        method: request.method,
        durationMs: Date.now() - startedAt
      }));
    }
  }
} satisfies ExportedHandler<Env>;

function requestedCapabilityScope(parts: string[], method: string): HostedExecutionCapabilityScope | null {
  if (parts[3] === "processes") {
    if (parts.length === 4 && method === "POST") return "process:launch";
    if (parts.length === 5 && method === "GET") return "process:inspect";
    if (parts.length === 6 && parts[5] === "kill" && method === "POST") return "process:kill";
  }
  if (parts[3] === "browser") {
    if (parts.length === 5 && parts[4] === "navigate" && method === "POST") return "browser:navigate";
    if (parts.length === 5 && parts[4] === "act" && method === "POST") return "browser:act";
    if (parts.length === 5 && parts[4] === "snapshot" && method === "GET") return "browser:snapshot";
  }
  return null;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new HostedRunnerRequestError("A JSON body is required.", "missing-body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel("body-too-large");
        throw new HostedRunnerRequestError("The request body is too large.", "body-too-large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HostedRunnerRequestError("The request body is not valid JSON.", "invalid-json");
  }
}

function safeOperationCode(error: unknown): string {
  if (!(error instanceof Error) || !/^[a-z0-9-]{1,80}$/.test(error.message)) return "hosted-runner-unavailable";
  return error.message;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
