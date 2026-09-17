/**
 * Runs a provider-neutral `AgentBackend` and routes its events into the shell.
 *
 * The hook resolves the connected backend to an `AgentBackend` via
 * `resolveAgentBackend` (native API and Codex app-server have live adapters).
 * It then runs the backend, consuming
 * the universal `BackendAgentEvent` stream, and:
 *   - accumulates text deltas into the agent transcript
 *   - pushes tool-call approvals into the shell's approval queue (via onToolCall)
 *   - records usage for display
 *   - signals real cancellation to the backend (which drops it at egress)
 *
 * The provider-id wire-family details (request shaping, SSE parsing, the Tauri
 * transport) live inside the native-API adapter + `createDesktopTransport`, not
 * here — so this hook is provider-neutral. Outside the desktop runtime the hook
 * surfaces a no-transport notice so the UI stays fixture-testable.
 *
 * Implementation lives in `hooks/native-agent/`. This file is the stable public
 * facade so call sites keep importing `useNativeAgent` and its types from here.
 */

export { useNativeAgent } from "./native-agent/useNativeAgent";
export type {
  NativeAgentRunControl,
  NativeAgentState,
  UseNativeAgentOptions,
} from "./native-agent/types";
