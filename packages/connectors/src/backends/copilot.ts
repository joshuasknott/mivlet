/** Backward-compatible Copilot resolver, now backed by the live ACP adapter. */

import type { BackendProvider } from "@fable/protocol";
import { ACP_BACKEND_TYPE, resolveAcpProvider } from "./acp";

export const COPILOT_PROVIDER_ID = "copilot";
export const COPILOT_BACKEND_TYPE = ACP_BACKEND_TYPE;

/** Copilot CLI owns login/token selection; credentials never enter Fable. */
export const COPILOT_AUTH_MODES = ["cli"] as const;
export type CopilotAuthMode = (typeof COPILOT_AUTH_MODES)[number];

export function resolveCopilotProvider(
  authState: BackendProvider["authState"]
): BackendProvider {
  return resolveAcpProvider("copilot", authState);
}
