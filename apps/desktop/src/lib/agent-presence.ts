import type { NativeAgentState } from "../hooks/useNativeAgent";

export type AgentPresence = "idle" | "received" | "thinking" | "working" | "waiting" | "input" | "service" | "human" | "paused" | "unavailable" | "listening" | "speaking" | "blocked" | "done";

export const PRESENCE_LABELS: Record<AgentPresence, string> = {
  idle: "Ready",
  received: "Starting",
  thinking: "Thinking",
  working: "Working",
  waiting: "Approve action",
  input: "Needs your answer",
  service: "Waiting for provider",
  human: "You're in control",
  paused: "Paused",
  unavailable: "Connect a provider",
  listening: "Listening",
  speaking: "Speaking",
  blocked: "Needs attention",
  done: "Finished",
};

export interface PresenceContext {
  /** Only pass computer control when this activity concerns that computer. */
  computerController?: "agent" | "human" | "paused";
  providerUnavailable?: boolean;
  listening?: boolean;
  /** A confirmed playback event, never text streaming. */
  speaking?: boolean;
  /** An explicit input request, never inferred from the model's prose. */
  awaitingInput?: boolean;
}

export interface PresenceScope {
  agentId?: string;
  threadId?: string;
}

/**
 * Progress is renderer-local, so it must be tied to the selected agent and
 * conversation before it can drive an avatar or status label. Missing scope
 * fields are allowed for the initial idle state and older preview fixtures.
 */
export function isPresenceScopeCurrent(
  state: Pick<NativeAgentState, "progressAgentId" | "progressThreadId">,
  scope: PresenceScope,
) {
  if (state.progressAgentId && state.progressAgentId !== scope.agentId) return false;
  if (state.progressThreadId !== undefined && state.progressThreadId !== scope.threadId) return false;
  return true;
}

/** Presentation follows execution facts; an approval always takes priority over activity. */
export function agentPresence(
  state: Pick<NativeAgentState, "running" | "status" | "activity" | "lastError" | "responseParts" | "transcript" | "stopRequested">,
  awaitingApproval = false,
  queued = false,
  context: PresenceContext = {},
): AgentPresence {
  if (awaitingApproval || (state.status === "awaiting-approval" && !state.stopRequested)) return "waiting";
  if (context.computerController === "human") return "human";
  if (context.computerController === "paused") return "paused";
  if (state.stopRequested || state.status === "cancelled" || state.status === "interrupted") return "paused";
  if (state.lastError || state.status === "failed") return "blocked";
  if (context.awaitingInput) return "input";
  if (context.listening) return "listening";
  if (context.speaking) return "speaking";
  if (context.providerUnavailable && !state.running) return "unavailable";
  if (queued) return "received";
  if (state.running) {
    if (state.status === "retrying") return "service";
    if (state.activity || state.responseParts?.some((part) => part.kind === "tool" && part.state === "running")) return "working";
    if (state.transcript) return "working";
    return "thinking";
  }
  return state.status === "completed" ? "done" : "idle";
}
