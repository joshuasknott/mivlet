import type { BackendTool } from "@mivlet/protocol";

const text = { type: "string" };
const target = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]+$" };
const binding = {
  consumer: { type: "string", enum: ["webhook-signing-key"] },
  purpose: { type: "string", enum: ["verify-webhook-signature"] },
  targetId: target,
};
const key = { keyId: text, targetId: target };
function tool(name: string, description: string, properties: Record<string, unknown>, write = false): BackendTool {
  return { name, description, defaultMode: write ? "full-access" : "read-only", defaultRisk: write ? "high" : "low",
    parameters: JSON.stringify({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) };
}

/** No value/password/secret input is exposed to the model or renderer. */
export const PROTECTED_SECRET_TOOLS: BackendTool[] = [
  tool("request-secret", "Ask the human for a webhook signing secret in protected native entry. Never ask for the value in chat. Name a specific label/reason and exact targetId, consumer and purpose. Returns declined or a 10-minute one-use secretRef bound to this account, workspace, agent and generation. Stop/restart invalidate it. Native Windows only; cannot run during application control.",
    { label: { type: "string", minLength: 1, maxLength: 80 }, reason: { type: "string", minLength: 1, maxLength: 240 }, ...binding }, true),
  tool("secret-request-status", "Inspect this agent's recent protected request statuses. No values or reusable references are returned. An interrupted/expired request needs a fresh request-secret.", {}),
  tool("webhook-signing-install", "Consume a ready secretRef once to install an HMAC-SHA256 webhook verification key for its exact approved target. Use requestId and secretRef from request-secret with the same consumer/purpose/targetId. Returns keyId only. Does not create a webhook, deliver an event or schedule Work. Inspect status after interruption; never replay a reference.",
    { requestId: text, secretRef: text, ...binding }, true),
  tool("webhook-signing-status", "Check native custody for an installed webhook verification key. Key is bound to this account, workspace, agent and exact targetId. No value is returned.", key),
  tool("webhook-signing-verify", "Locally verify a nonsecret test event body against a sha256=<hex> HMAC header using an installed key. Returns verified only; never returns a key or signature, starts Work or sends a network request. Pass only public/synthetic test event content here.",
    { ...key, body: { type: "string", maxLength: 1048576 }, signature: { type: "string", pattern: "^sha256=[A-Fa-f0-9]{64}$" } }),
  tool("webhook-signing-remove", "Revoke an exact webhook verification key and remove it from native custody. Future signature checks fail closed. This does not delete a schedule or event history.", key, true),
];

export function isProtectedSecretTool(name: string): boolean {
  return PROTECTED_SECRET_TOOLS.some(tool => tool.name === name);
}
