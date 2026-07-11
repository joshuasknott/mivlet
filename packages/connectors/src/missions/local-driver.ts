import type { AgentRunOptions, ApprovalRequest, BackendAgentEvent, NativeToolSpec } from "@fable/protocol";
import type { Spine } from "@fable/protocol";
import type { AgentBackend } from "../agent-runtime";

export interface LocalWorkerExecutionInput {
  worker: Spine.Missions.Worker;
  backend: AgentBackend;
  model: string;
  prompt: string;
  toolSpecs: readonly NativeToolSpec[];
  execute: AgentRunOptions["execute"];
  contextPrefix?: string;
  signal?: AbortSignal;
  onEvent?: (event: BackendAgentEvent) => void | Promise<void>;
}

export interface LocalWorkerExecutionOutcome {
  status: "completed" | "partially-completed" | "failed" | "cancelled";
  text: string;
  events: readonly BackendAgentEvent[];
  usage: { inputTokens: number; outputTokens: number; toolCalls: number; costUsd: number; costUnknown: boolean };
  reason?: string;
  retryable: boolean;
}

/** Execute one already-authorized worker through the provider-neutral backend. */
export async function executeLocalWorker(input: LocalWorkerExecutionInput): Promise<LocalWorkerExecutionOutcome> {
  const { worker } = input;
  if (worker.status !== "proposed" && worker.status !== "queued") {
    throw new Error("Only a proposed or queued worker can start local execution.");
  }
  if (!input.prompt.trim()) throw new Error("Worker execution requires an explicit prompt.");
  const requiredTools = new Set(worker.tools.map((tool) => tool.toolName));
  const suppliedTools = new Set(input.toolSpecs.map((tool) => tool.name));
  if (requiredTools.size !== suppliedTools.size || [...requiredTools].some((name) => !suppliedTools.has(name))) {
    throw new Error("Worker tool specifications must exactly match its bounded tool set.");
  }

  const maxToolCalls = worker.budget.maxToolCalls ?? 0;
  const maxOutputTokens = worker.budget.maxOutputTokens ?? 1;
  const maxInputTokens = worker.budget.maxInputTokens;
  const events: BackendAgentEvent[] = [];
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let costUsd = 0;
  let costUnknown = false;
  let terminal: BackendAgentEvent | undefined;
  let budgetFailure: string | undefined;

  const execute = async (approval: ApprovalRequest, args: string) => {
    const toolName = approval.action.split(/\s+/)[0];
    if (!requiredTools.has(toolName)) throw new Error("Backend requested a tool outside the worker's bounded tool set.");
    if (toolCalls >= maxToolCalls) throw new Error("Worker tool-call budget is exhausted.");
    toolCalls += 1;
    return input.execute(approval, args);
  };
  const stream = input.backend.run(
    {
      model: input.model,
      messages: [{ role: "user", content: input.prompt.trim() }],
      tools: [...input.toolSpecs],
      maxTokens: maxOutputTokens
    },
    {
      execute,
      runId: worker.runId,
      contextPrefix: input.contextPrefix,
      shouldCancel: () => input.signal?.aborted ?? false,
      maxTurns: worker.budget.maxAttempts ?? 1,
      maxToolCalls,
      maxToolOutputCharacters: Math.min(32_000, Math.max(1_000, maxOutputTokens * 4))
    }
  );
  if (!stream) return outcome("failed", "The selected backend has no local execution transport.", true);

  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + (worker.budget.maxDurationMs ?? 1);
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await input.backend.cancel(worker.runId);
      return outcome(text ? "partially-completed" : "failed", "Worker duration budget was exceeded.", false);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      iterator.next().then((value) => ({ kind: "event" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), remaining); })
    ]);
    if (timer) clearTimeout(timer);
    if (next.kind === "timeout") {
      await input.backend.cancel(worker.runId);
      return outcome(text ? "partially-completed" : "failed", "Worker duration budget was exceeded.", false);
    }
    if (next.value.done) break;
    const event = next.value.value;
    events.push(event);
    await input.onEvent?.(event);
    if (event.type === "text-delta") text += event.text;
    if (event.type === "usage") {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      costUsd += event.costUsd;
      costUnknown ||= event.costUnknown === true;
      if (maxInputTokens !== undefined && inputTokens > maxInputTokens) budgetFailure = "Worker input-token budget was exceeded.";
      if (outputTokens > maxOutputTokens) budgetFailure = "Worker output-token budget was exceeded.";
    }
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") terminal = event;
    if (budgetFailure) {
      await input.backend.cancel(worker.runId);
      break;
    }
  }

  if (budgetFailure) return outcome(text ? "partially-completed" : "failed", budgetFailure, false);
  if (input.signal?.aborted || terminal?.type === "cancelled") return outcome("cancelled", "Worker execution was cancelled.", false);
  if (!terminal) return outcome(text ? "partially-completed" : "failed", "The backend ended without a terminal event.", true);
  if (terminal.type === "error") return outcome(text ? "partially-completed" : "failed", terminal.message, terminal.retryable === true);
  if (terminal.type === "done" && terminal.finishReason === "length") {
    return outcome("partially-completed", "The worker reached its output limit.", false);
  }
  if (terminal.type === "done" && terminal.finishReason !== "error") return outcome("completed", undefined, false);
  return outcome(text ? "partially-completed" : "failed", "Worker execution failed.", false);

  function outcome(status: LocalWorkerExecutionOutcome["status"], reason: string | undefined, retryable: boolean): LocalWorkerExecutionOutcome {
    return { status, text, events, usage: { inputTokens, outputTokens, toolCalls, costUsd, costUnknown }, reason, retryable };
  }
}
