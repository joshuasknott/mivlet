import {
  hostedTaskSha256, readHostedTaskCapability,
  type HostedCredentialEnrollment, type HostedTaskCapability, type HostedTaskCapabilityScope,
} from "@mivlet/protocol";
import { admission, boundedObject, exactKeys, identifier, integer, provider, readJson } from "./contracts";
import { ProviderCustody } from "./provider-custody";
import { TaskAuthority } from "./task-authority";
import type { TaskEnv } from "./environment";

export { ProviderCustody, TaskAuthority };
const ROUTES = {
  "tasks/admit": "task:admit", "tasks/read": "task:read", "tasks/cancel": "task:cancel",
  "credentials/enroll": "credential:enroll", "credentials/read": "credential:read", "credentials/revoke": "credential:revoke",
} satisfies Record<string, HostedTaskCapabilityScope>;
const SAFE_FAILURES = new Set([
  "invalid-task-request", "invalid-task-target", "invalid-task-budget", "invalid-task-model", "invalid-task-reasoning",
  "invalid-task-input", "invalid-hosted-api-key", "hosted-api-provider-required", "hosted-text-only", "hosted-secret-content", "hosted-local-path-content",
  "task-input-mismatch", "task-scope-mismatch", "task-account-mismatch", "task-body-required", "task-body-too-large",
  "credential-scope-mismatch", "credential-revision-mismatch", "hosted-credential-limit", "hosted-provider-connection-required",
  "task-admission-conflict", "task-admission-expired", "task-generation-mismatch", "task-not-found", "hosted-task-quota",
  "task-capability-expired", "task-capability-replayed", "task-capability-rate-limited", "task-custody-configuration-required",
]);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export default {
  async fetch(request: Request, env: TaskEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ service: "mivlet-hosted-tasks", mode: "text-only", version: 1 });
    const path = url.pathname.split("/");
    if (request.method !== "POST" || path.length !== 5 || path[1] !== "v1" || url.search) return json({ error: "not-found" }, 404);
    const route = `${path[2]}/${path[4]}` as keyof typeof ROUTES; const scope = ROUTES[route];
    if (!scope) return json({ error: "not-found" }, 404);
    let cap: HostedTaskCapability;
    try {
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith("MivletTask ")) throw new Error("unauthorized");
      cap = await readHostedTaskCapability(env.MIVLET_HOSTED_TASK_SIGNING_KEY, authorization.slice(11));
      if (cap.scope !== scope || cap.resourceId !== identifier(path[3])) throw new Error("unauthorized");
    } catch { return json({ error: "task-authorization-required" }, 401); }
    try {
      const body = boundedObject(await readJson(request));
      // Key bytes intentionally never traverse Convex. Its capability signs
      // exact enrollment metadata; only native supplies the separately entered
      // secret directly to this HTTPS route. Other routes bind the whole body.
      const hashed = scope === "credential:enroll" ? body.metadata : body;
      if (await hostedTaskSha256(hashed) !== cap.requestSha256) throw new Error("task-input-mismatch");
      const custody = env.PROVIDER_CUSTODY.getByName(cap.accountId);
      if (scope === "task:admit") {
        const value = await admission(body, cap);
        await custody.consume(cap);
        await custody.reserve(cap, value.binding, cap.requestSha256);
        const task = env.TASK_AUTHORITY.getByName(`${cap.accountId}:${value.binding.taskId}`);
        return json(await task.admit(cap, value), 202);
      }
      if (scope === "credential:enroll") {
        exactKeys(body, ["metadata", "secret"]);
        const metadata = boundedObject(body.metadata); exactKeys(metadata, ["credentialId", "providerId", "revision"]);
        if (identifier(metadata.credentialId) !== cap.resourceId || typeof body.secret !== "string") throw new Error("credential-scope-mismatch");
        const enrollment: HostedCredentialEnrollment = { credentialId: metadata.credentialId as string, providerId: provider(metadata.providerId), revision: integer(metadata.revision, 1, 0xffff_ffff) };
        await custody.consume(cap);
        return json(await custody.enroll(cap, enrollment, body.secret));
      }
      if (scope === "credential:read") {
        exactKeys(body, ["resourceId"]); if (body.resourceId !== cap.resourceId) throw new Error("credential-scope-mismatch");
        await custody.consume(cap); return json(await custody.connections(cap));
      }
      if (scope === "credential:revoke") {
        exactKeys(body, ["credentialId", "revision"]); if (body.credentialId !== cap.resourceId) throw new Error("credential-scope-mismatch");
        const revision = integer(body.revision, 1, 0xffff_ffff);
        await custody.consume(cap); return json(await custody.revoke(cap, revision));
      }
      exactKeys(body, scope === "task:cancel" ? ["taskId", "generation"] : ["taskId"]);
      if (body.taskId !== cap.resourceId) throw new Error("task-scope-mismatch");
      const generation = scope === "task:cancel" ? integer(body.generation, 1, 0xffff_ffff) : undefined;
      await custody.consume(cap);
      const task = env.TASK_AUTHORITY.getByName(`${cap.accountId}:${cap.resourceId}`);
      return json(generation !== undefined ? await task.cancel(cap, generation) : await task.read(cap));
    } catch (error) {
      const code = error instanceof Error && SAFE_FAILURES.has(error.message) ? error.message : "hosted-task-unavailable";
      const status = code === "task-not-found" ? 404 : code.endsWith("quota") || code.endsWith("limited") || code.endsWith("limit") ? 429 : code.endsWith("configuration-required") ? 503 : 409;
      // No request/provider bodies, tokens or credentials enter logs/errors.
      return json({ error: code }, status);
    }
  },
};
