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
  "opencode",
  "kimi",
  "mistral-vibe",
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "openrouter",
  "deepseek",
  "zai",
  "minimax",
  "alibaba",
  "fireworks",
  "huggingface",
  "moonshot",
  "kimi-code",
  "mistral",
  "meta",
  "perplexity",
  "tencent",
  "xiaomi",
  "groq",
  "together",
  "cerebras",
  "custom"
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
    resolveCopilotProvider("install-required"),
    resolveAcpProvider("grok", "install-required"),
    resolveAcpProvider("opencode", "install-required"),
    resolveAcpProvider("kimi", "install-required"),
    resolveAcpProvider("mistral-vibe", "install-required"),
    resolveNativeProvider("openai", "needs-auth"),
    resolveNativeProvider("anthropic", "needs-auth"),
    resolveNativeProvider("gemini", "needs-auth"),
    resolveNativeProvider("xai", "needs-auth"),
    resolveNativeProvider("openrouter", "needs-auth"),
    resolveNativeProvider("deepseek", "needs-auth"),
    resolveNativeProvider("zai", "needs-auth"),
    resolveNativeProvider("minimax", "needs-auth"),
    resolveNativeProvider("alibaba", "needs-auth"),
    resolveNativeProvider("fireworks", "needs-auth"),
    resolveNativeProvider("huggingface", "needs-auth"),
    resolveNativeProvider("moonshot", "needs-auth"),
    resolveNativeProvider("kimi-code", "needs-auth"),
    resolveNativeProvider("mistral", "needs-auth"),
    resolveNativeProvider("meta", "needs-auth"),
    resolveNativeProvider("perplexity", "needs-auth"),
    resolveNativeProvider("tencent", "needs-auth"),
    resolveNativeProvider("xiaomi", "needs-auth"),
    resolveNativeProvider("groq", "needs-auth"),
    resolveNativeProvider("together", "needs-auth"),
    resolveNativeProvider("cerebras", "needs-auth"),
    resolveNativeProvider("custom", "needs-auth")
  ];
}

export { resolveCapabilities, hasCapability } from "./capabilities";
export { resolveCodexProvider } from "./codex";
export { resolveCopilotProvider } from "./copilot";
export {
  resolveAcpProvider,
  resolveCursorProvider,
  resolveGrokProvider,
  resolveOpenCodeProvider,
  resolveKimiProvider,
  resolveMistralVibeProvider
} from "./acp";
export { resolveNativeProvider, NATIVE_BACKEND_TYPE } from "./native";
