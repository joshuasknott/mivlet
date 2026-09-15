import { toRuntimeError } from "../errors";
import type {
  BackendCredentialRequest,
  AgentTurnRequest,
  BackendProvider,
  BackendVerifyResult,
  ProviderRoutePricingEvidence,
  ProviderRouteQualitySnapshot,
  Spine,
} from "@mivlet/protocol";
import { hasTauriRuntime, invoke, invokeNative, listen } from "../bridge";

// ---------------------------------------------------------------------------
// Agent-runtime backends (Codex browser sign-in and direct provider APIs)
//
// The Rust credential boundary owns secrets. These wrappers expose auth state
// + capabilities only. Outside Tauri they return null so the shell falls back
// to the preview backend registry and stays testable.
// ---------------------------------------------------------------------------

export async function listRuntimeBackends() {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<BackendProvider[]>("list_backends");
  } catch {
    return null;
  }
}

export async function connectRuntimeBackend(request: BackendCredentialRequest) {
  return invokeNative<string>("store_backend_credential", { request });
}

/**
 * Verify a stored native-API credential. Rust looks the key up inside the
 * credential boundary and hit-tests it against the provider; the secret never
 * crosses into JavaScript. Returns null outside Tauri so the preview shell
 * falls back to a local preview connection and stays fixture-testable.
 *
 * Outcomes map to provider connection state:
 *   - `ready` → the provider is connected; reflect it as connected.
 *   - `auth-failed` → the key was rejected; clear it and surface a useful error.
 *   - `offline` / `unsupported` / `failed` → keep the stored key, show a warning.
 */
export async function verifyRuntimeBackend(
  providerId: string,
): Promise<BackendVerifyResult | null> {
  if (!hasTauriRuntime()) {
    return null;
  }

  try {
    return await invoke<BackendVerifyResult>("verify_backend_credential", {
      providerId,
    });
  } catch (error) {
    // A command failure is treated as a transient failure, not auth failure:
    // the stored key may still be good.
    return {
      providerId,
      outcome: "failed",
      message: toRuntimeError(error).message,
    };
  }
}

export async function clearRuntimeBackend(providerId: string) {
  return invokeNative<string>("clear_backend_credential", { providerId });
}

// ---------------------------------------------------------------------------
// Native-API agent-loop transport bridge.
//
// The TypeScript layer owns orchestration (loop control, tool-call handling,
// approval routing) as pure logic; Rust owns the API key + HTTP/SSE egress.
// `streamRuntimeCompletion` hands Rust an opaque request (no key) and Rust emits
// normalized SSE lines on the legacy `arden://backend/<requestId>` channel.
// The name is intentionally stable for compatibility with existing runtimes.
// Outside Tauri these return null so the loop stays fixture-testable.
// ---------------------------------------------------------------------------

export interface RuntimeStreamRequest {
  providerId: string;
  requestId: string;
  model: string;
  body: unknown;
  providerRoute?: import("@mivlet/protocol").ProviderRouteExecutionBinding;
  computerSessionId?: string;
}

export async function beginRuntimeComputerSession(request: {
  providerId: string;
  model: string;
  computer: { workspaceId: string; agentId: string };
  providerRoute: import("@mivlet/protocol").ProviderRouteExecutionBinding;
}): Promise<string> {
  if (!hasTauriRuntime())
    throw new Error("Native screenshot delivery requires the desktop runtime.");
  return invoke<string>("begin_native_computer_session", { request });
}

export async function endRuntimeComputerSession(
  sessionId: string,
): Promise<void> {
  if (hasTauriRuntime())
    await invoke("end_native_computer_session", { sessionId });
}

interface RuntimeMediaImageStatus {
  providerId: "openai";
  configured: boolean;
  models: ["gpt-image-2"];
  sizes: Array<"1024x1024" | "1536x1024" | "1024x1536">;
  qualities: Array<"low" | "medium" | "high">;
  outputMimeType: "image/png";
  generationAvailable: boolean;
  editingAvailable: boolean;
  message: string;
}

export type RuntimeNativeProviderRoute = Spine.Connections.ProviderRoute & {
  observationSummary?: {
    reference: string;
    sampleCount: number;
    medianLatencyMs: number;
    usageSampleCount: number;
    latestObservedAt: string;
  };
  pricingSummary?: ProviderRoutePricingEvidence;
  qualitySummary?: ProviderRouteQualitySnapshot;
};

export async function listRuntimeNativeProviderRoutes() {
  return invokeNative<RuntimeNativeProviderRoute[]>(
    "list_native_provider_routes",
  );
}

/** Begin a streaming completion. Rust adds the key + performs the HTTP call. */
export async function streamRuntimeCompletion(request: RuntimeStreamRequest) {
  return invokeNative<null>("stream_backend_completion", { request });
}

/** Cancel an in-flight completion (real cancellation at the Rust boundary). */
export async function cancelRuntimeCompletion(requestId: string) {
  return invokeNative<boolean>("cancel_backend_completion", { requestId });
}

/**
 * Discover the available model ids for a connected native provider. Rust looks
 * up the key (fail closed — no egress without a credential), issues a bounded
 * GET to the provider's list-models endpoint, and returns the parsed ids. Returns
 * null outside Tauri so the shell falls back to the curated catalogue and stays
 * fixture-testable. A null/empty result is treated as "discovery did not run".
 */
interface RuntimeDiscoveredModel {
  id: string;
  available: boolean;
  label?: string;
  capabilities?: import("@mivlet/protocol").ModelCapabilities;
  reasoning?: import("@mivlet/protocol").BackendModel["reasoning"];
}

export interface RuntimeModelDiscoveryResult {
  outcome: "success" | "unsupported" | "offline" | "failed" | "empty";
  models: RuntimeDiscoveredModel[];
  message?: string;
}

export async function listRuntimeBackendModels(providerId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    if (providerId === "antigravity") {
      const models = await invoke<BackendProvider["models"]>(
        "list_antigravity_models",
      );
      return {
        outcome: models.length ? ("success" as const) : ("empty" as const),
        models,
      };
    }
    if (["claude", "cursor", "grok", "opencode"].includes(providerId)) {
      const models = await invoke<BackendProvider["models"]>(
        "list_managed_runtime_models",
        {
          providerId,
        },
      );
      return {
        outcome: models.length ? ("success" as const) : ("empty" as const),
        models,
      };
    }
    return await invoke<RuntimeModelDiscoveryResult>("list_backend_models", {
      providerId,
    });
  } catch (error) {
    return {
      outcome: "failed" as const,
      models: [],
      message: toRuntimeError(error).message,
    };
  }
}

export async function listenRuntimeBackendEvents(
  requestId: string,
  onLine: (line: string) => void,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  try {
    const unlisten = await listen<string>(
      `arden://backend/${requestId}`,
      (event) => {
        onLine(event.payload as string);
      },
    );
    return unlisten;
  } catch {
    return null;
  }
}

interface RuntimeCodexStatus {
  installed: boolean;
  authenticated: boolean;
  authMethod?: "chatgpt" | "api-key" | "provider-login";
  version?: string;
  message?: string;
}

export interface RuntimeCodexBrowserLoginResult {
  providerId: "codex";
  outcome: "ready";
  message: string;
}

export interface RuntimeCodexTurnStartRequest {
  requestId: string;
  providerId: string;
  threadId: string | null;
  request: AgentTurnRequest;
  options: {
    contextPrefix?: string;
    permissionMode?: string;
    runId?: string;
    computer?: { workspaceId: string; agentId: string };
  };
}

export type RuntimeCodexEvent =
  | { type: "thread"; threadId: string }
  | { type: "turn"; turnId: string }
  | { type: "retrying" }
  | { type: "process-exited" }
  | {
      type: "approval-request";
      requestId: string;
      callId: string;
      tool: string;
      arguments: string;
      approval: import("@mivlet/protocol").ApprovalRequest;
    }
  | { type: "text-delta"; text: string }
  | {
      type: "reasoning-summary";
      text: string;
      itemId: string;
      summaryIndex: number;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "error"; message: string }
  | { type: "cancelled" };

export async function startRuntimeCodexBrowserLogin() {
  return invokeNative<RuntimeCodexBrowserLoginResult>(
    "start_codex_browser_login",
  );
}

export async function startRuntimeCodexTurn(
  request: RuntimeCodexTurnStartRequest,
) {
  return invokeNative<null>("start_codex_app_server_turn", { request });
}

export async function respondRuntimeCodexApproval(request: {
  requestId: string;
  approvalRequestId: string;
  result: { callId: string; ok: boolean; output: string };
}) {
  return invokeNative<null>("respond_codex_app_server_approval", { request });
}

export async function interruptRuntimeCodexTurn(request: {
  requestId: string;
  threadId: string;
  turnId?: string;
}) {
  return invokeNative<null>("interrupt_codex_app_server_turn", { request });
}

export async function shutdownRuntimeCodexTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("shutdown_codex_app_server_turn", { requestId });
  } catch {
    return null;
  }
}

export async function listenRuntimeCodexEvents(
  requestId: string,
  onEvent: (event: RuntimeCodexEvent) => void,
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<RuntimeCodexEvent>(
      `mivlet://codex/${requestId}`,
      (event) => {
        onEvent(event.payload);
      },
    );
    return unlisten;
  } catch {
    return null;
  }
}

export interface RuntimeAntigravityStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  message?: string;
}

export type RuntimeAntigravityEvent = Extract<
  RuntimeCodexEvent,
  {
    type:
      | "approval-request"
      | "text-delta"
      | "done"
      | "error"
      | "cancelled"
      | "process-exited";
  }
>;

export async function getRuntimeAntigravityStatus() {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeAntigravityStatus>("antigravity_status").catch(() => ({
    installed: false,
    authenticated: false,
    message: "Mivlet could not inspect the Antigravity runtime.",
  }));
}

export async function installRuntimeAntigravity() {
  return invokeNative<{
    providerId: "antigravity";
    version: string;
    installed: boolean;
  }>("install_antigravity_runtime");
}

export async function startRuntimeAntigravityBrowserLogin() {
  return invokeNative<{
    providerId: "antigravity";
    outcome: "ready";
    message: string;
  }>("start_antigravity_browser_login");
}

export async function checkRuntimeAntigravityConnection() {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<BackendVerifyResult>("check_antigravity_connection");
  } catch (error) {
    return {
      providerId: "antigravity",
      outcome: "failed" as const,
      message: toRuntimeError(error).message,
    };
  }
}

export async function startRuntimeAntigravityTurn(request: {
  requestId: string;
  providerId: string;
  request: AgentTurnRequest;
  options: { contextPrefix?: string; permissionMode?: string; runId?: string };
}) {
  return invokeNative<null>("start_antigravity_acp_turn", { request });
}

export async function respondRuntimeAntigravityApproval(request: {
  requestId: string;
  approvalRequestId: string;
  approved: boolean;
}) {
  return invokeNative<null>("respond_antigravity_acp_approval", { request });
}

export async function interruptRuntimeAntigravityTurn(requestId: string) {
  return invokeNative<null>("interrupt_antigravity_acp_turn", { requestId });
}

export async function shutdownRuntimeAntigravityTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("shutdown_antigravity_acp_turn", { requestId });
  } catch {
    return null;
  }
}

export async function logoutRuntimeAntigravity() {
  return invokeNative<null>("logout_antigravity");
}

export async function listenRuntimeAntigravityEvents(
  requestId: string,
  onEvent: (event: RuntimeAntigravityEvent) => void,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await listen<RuntimeAntigravityEvent>(
      `mivlet://antigravity/${requestId}`,
      (event) => onEvent(event.payload),
    );
  } catch {
    return null;
  }
}

export type ManagedRuntimeProviderId =
  "claude" | "cursor" | "grok" | "opencode";

export interface RuntimeManagedStatus {
  providerId: ManagedRuntimeProviderId;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  message?: string;
}

export type RuntimeManagedEvent = RuntimeCodexEvent;

export async function getRuntimeManagedStatus(
  providerId: ManagedRuntimeProviderId,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<RuntimeManagedStatus>("managed_runtime_status", {
      providerId,
    });
  } catch {
    return {
      providerId,
      installed: false,
      authenticated: false,
      message: `Mivlet could not inspect the ${providerId} runtime.`,
    };
  }
}

export async function checkRuntimeManagedConnection(
  providerId: ManagedRuntimeProviderId,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<BackendVerifyResult>(
      "check_managed_runtime_connection",
      { providerId },
    );
  } catch (error) {
    return {
      providerId,
      outcome: "failed" as const,
      message: toRuntimeError(error).message,
    };
  }
}

export async function startRuntimeManagedLogin(
  providerId: Exclude<ManagedRuntimeProviderId, "opencode">,
) {
  return invokeNative<{
    providerId: string;
    outcome: "ready";
    message: string;
  }>("start_managed_runtime_login", { providerId });
}

export async function startRuntimeManagedTurn(request: {
  requestId: string;
  providerId: ManagedRuntimeProviderId;
  request: AgentTurnRequest;
  options: { contextPrefix?: string; permissionMode?: string; runId?: string };
}) {
  return invokeNative<null>("start_managed_runtime_turn", { request });
}

export async function respondRuntimeManagedApproval(request: {
  requestId: string;
  approvalRequestId: string;
  approved: boolean;
}) {
  return invokeNative<null>("respond_managed_runtime_approval", { request });
}

export async function interruptRuntimeManagedTurn(requestId: string) {
  return invokeNative<null>("interrupt_managed_runtime_turn", { requestId });
}

export async function shutdownRuntimeManagedTurn(requestId: string) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<null>("shutdown_managed_runtime_turn", { requestId });
  } catch {
    return null;
  }
}

export async function logoutRuntimeManaged(
  providerId: ManagedRuntimeProviderId,
) {
  return invokeNative<null>("logout_managed_runtime", { providerId });
}

export async function listenRuntimeManagedEvents(
  providerId: ManagedRuntimeProviderId,
  requestId: string,
  onEvent: (event: RuntimeManagedEvent) => void,
) {
  if (!hasTauriRuntime()) return null;
  try {
    return await listen<RuntimeManagedEvent>(
      `mivlet://managed-runtime/${providerId}/${requestId}`,
      (event) => onEvent(event.payload),
    );
  } catch {
    return null;
  }
}
