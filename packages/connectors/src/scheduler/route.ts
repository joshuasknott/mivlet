/**
 * Scheduled execution route resolution.
 *
 * A schedule pins which backend/model/permission runs it so scheduled work never
 * silently switches provider, model, or permission mode. At run time the pinned
 * route is honored when the pinned backend is still connected; otherwise the
 * route falls back to the current default connected backend.
 *
 * Pure + side-effect-free so it is deterministic-clock-testable.
 */

import type {
  BackendModel,
  BackendProvider,
  PermissionMode,
  ScheduledExecutionRoute
} from "@fable/protocol";

/**
 * Capture a route at schedule-create time. If a connected backend is present
 * the route is pinned to it; otherwise it is `current-default` (resolved live
 * at execution time).
 */
export function captureExecutionRoute(
  connectedBackend: BackendProvider | undefined,
  selectedModelId: string,
  permissionMode: PermissionMode
): ScheduledExecutionRoute {
  if (!connectedBackend) {
    return {
      policy: "current-default",
      backendId: "",
      modelId: selectedModelId,
      permissionMode
    };
  }
  return {
    policy: "pinned",
    backendId: connectedBackend.id,
    modelId: selectedModelId || (connectedBackend.models.find((m) => m.available)?.id ?? ""),
    permissionMode
  };
}

/**
 * The live backend + model a scheduled run should use, resolved against the
 * current connection state. Returns null when no backend is available (caller
 * surfaces `blocked-auth`).
 *
 * - `pinned`: use the pinned backend if still connected + model still available,
 *   else fall back to the default connected backend.
 * - `current-default`: use the default connected backend + its first available
 *   model.
 */
export interface ResolvedExecutionRoute {
  backend: BackendProvider;
  model: BackendModel;
  permissionMode: PermissionMode;
  /** True when the pinned backend was unavailable and we fell back. */
  fellBack: boolean;
}

export function resolveExecutionRoute(
  route: ScheduledExecutionRoute | undefined,
  defaultConnected: BackendProvider | undefined
): ResolvedExecutionRoute | null {
  if (!defaultConnected) return null;

  if (route && route.policy === "pinned" && route.backendId) {
    const pinned = defaultConnected.id === route.backendId ? defaultConnected : undefined;
    if (pinned) {
      const model =
        pinned.models.find((candidate) => candidate.id === route.modelId && candidate.available) ??
        pinned.models.find((candidate) => candidate.available);
      if (model) {
        return {
          backend: pinned,
          model,
          permissionMode: route.permissionMode,
          fellBack: false
        };
      }
    }
    // Pinned backend unavailable or model gone: fall back to default.
  }

  const model = defaultConnected.models.find((candidate) => candidate.available);
  if (!model) return null;
  return {
    backend: defaultConnected,
    model,
    permissionMode: route?.permissionMode ?? "read-only",
    fellBack: route?.policy === "pinned"
  };
}
