/**
 * Backend registry — the single source the desktop shell reads to enumerate
 * agent-runtime AI backends.
 *
 * Merges each adapter's logic-resolved provider with its default preview auth
 * state. This list is what the onboarding shell and connectors view render.
 * Outside Tauri (no real credential boundary) every provider starts at
 * `needs-auth` (or `install-required` for the ACP providers, since the CLI is
 * the gating dependency).
 */

import type { BackendProvider } from "@fable/protocol";
import { resolveCodexProvider } from "./codex";
import { resolveCopilotProvider } from "./copilot";
import { resolveAcpProvider } from "./acp";
import { resolveNativeProvider } from "./native";

export const BACKEND_PROVIDER_IDS = [
  "codex",
  "cursor",
  "copilot",
  "grok",
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "openrouter"
] as const;
export type BackendProviderId = (typeof BACKEND_PROVIDER_IDS)[number];
export type { AcpProviderId } from "./fixtures";
export type { NativeProviderId } from "./fixtures";

/**
 * The preview/default provider list. Used before the Rust credential boundary
 * resolves real auth state. Codex needs auth; the ACP providers (Cursor, Grok)
 * start install-required because their CLI is the gating dependency; Copilot
 * needs auth; the native-API providers (OpenAI, Anthropic, Gemini, xAI,
 * OpenRouter) start needs-auth — Fable owns their agent loop once a key exists.
 */
export function listBackendProviders(): BackendProvider[] {
  return [
    resolveCodexProvider("needs-auth"),
    resolveAcpProvider("cursor", "install-required"),
    resolveCopilotProvider("needs-auth"),
    resolveAcpProvider("grok", "install-required"),
    resolveNativeProvider("openai", "needs-auth"),
    resolveNativeProvider("anthropic", "needs-auth"),
    resolveNativeProvider("gemini", "needs-auth"),
    resolveNativeProvider("xai", "needs-auth"),
    resolveNativeProvider("openrouter", "needs-auth")
  ];
}

export { resolveCapabilities, hasCapability } from "./capabilities";
export { resolveCodexProvider } from "./codex";
export { resolveCopilotProvider } from "./copilot";
export {
  resolveAcpProvider,
  resolveCursorProvider,
  resolveGrokProvider
} from "./acp";
export { resolveNativeProvider, NATIVE_BACKEND_TYPE } from "./native";
