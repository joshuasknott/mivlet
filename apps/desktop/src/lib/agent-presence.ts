import type { NativeAgentState } from "../hooks/useNativeAgent";

export type AgentPresence = "idle" | "received" | "thinking" | "working" | "waiting" | "blocked" | "done";

export const PRESENCE_LABELS: Record<AgentPresence, string> = {
  idle: "Ready",
  received: "Starting",
  thinking: "Thinking",
  working: "Working",
  waiting: "Needs you",
  blocked: "Needs attention",
  done: "Finished",
};

/** Presentation follows execution facts; an approval always takes priority over activity. */
export function agentPresence(
  state: Pick<NativeAgentState, "running" | "status" | "activity" | "lastError" | "responseParts" | "transcript">,
  awaitingApproval = false,
  queued = false,
): AgentPresence {
  if (awaitingApproval || state.status === "awaiting-approval") return "waiting";
  if (state.lastError || state.status === "failed") return "blocked";
  if (queued) return "received";
  if (state.running) {
    if (state.activity || state.responseParts?.some((part) => part.kind === "tool" && part.state === "running")) return "working";
    if (state.transcript) return "working";
    return "thinking";
  }
  return state.status === "completed" ? "done" : "idle";
}
