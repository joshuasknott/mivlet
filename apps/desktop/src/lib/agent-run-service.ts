import { resolveAgentBackend, type BackendDeps } from "@fable/connectors";
import type {
  BackendModel,
  BackendProvider,
  ExecutionAttempt,
  ExecutionExchange,
  FableAgentProfile,
} from "@fable/protocol";
import { createDesktopCodexAppServer } from "./codex-app-server";
import { createDesktopTransport } from "./native-transport";
import { createDesktopAntigravityAcp } from "./antigravity-acp";
import { createDesktopManagedRuntime } from "./managed-runtime";
import { planConversationContext } from "./conversation-context";
import { describeBackendError } from "./backend-errors";
import { agentExecutionInstructions } from "./agent-learning";
import { createDesktopDurableRunWriter } from "../hooks/useDurableConversation";
import {
  createRuntimeConversationThread,
  listRuntimeBackendModels,
  saveRuntimeExecutionAttempt,
} from "../runtime";
import { getActiveRuntimeDataScope } from "../runtime-scope";

const SCHEDULED_RESEARCH_INSTRUCTIONS = [
  "This is scheduled web research.",
  "Use only Codex's provider-owned web search. Do not run commands, read or write local files, control the computer, call connectors, or request approval.",
  "Report the findings clearly in this conversation and include source links supplied by the web research result.",
].join(" ");

export type ScheduledResearchTerminal =
  "completed" | "failed" | "needs-user" | "interrupted";

export interface ScheduledResearchRunInput {
  attemptId: string;
  workspaceId: string;
  scheduleId: string;
  occurrenceId: string;
  prompt: string;
  providerId: string;
  model: string;
  agent: FableAgentProfile;
  provider: BackendProvider;
  modelDefinition: BackendModel;
  onQueued: (attempt: ExecutionAttempt) => Promise<void>;
  onThreadCreated?: (threadId: string) => void;
  /** Stable mount-generation fence owned by the app-lifetime dispatcher. */
  isCurrent: () => boolean;
  onBackendReady?: (cancel: () => Promise<void>) => void;
  onProgress?: (update: {
    threadId: string;
    transcript: string;
    activity?: string;
  }) => void;
}

export interface ScheduledResearchRunResult {
  terminal: ScheduledResearchTerminal;
  attempt: ExecutionAttempt;
  threadId: string;
  message?: string;
}

function deps(): BackendDeps {
  return {
    createTransport: createDesktopTransport,
    createCodexAppServer: createDesktopCodexAppServer,
    createAntigravityAcp: createDesktopAntigravityAcp,
    createManagedRuntime: createDesktopManagedRuntime,
    discoverModels: async (providerId) =>
      await listRuntimeBackendModels(providerId),
  };
}

function appendAssistant(
  exchanges: ExecutionExchange[],
  text: string,
): ExecutionExchange[] {
  const next = [...exchanges];
  const last = next.at(-1);
  if (last?.role === "assistant" && !last.toolCallId) {
    next[next.length - 1] = { ...last, content: last.content + text };
  } else {
    next.push({ role: "assistant", content: text });
  }
  return next;
}

function ensureCurrent(input: ScheduledResearchRunInput) {
  if (
    !input.isCurrent() ||
    getActiveRuntimeDataScope()?.workspaceId !== input.workspaceId
  ) {
    throw new Error(
      "The selected workspace changed before scheduled research could continue.",
    );
  }
}

/**
 * Narrow non-React execution service for one scheduled Codex research run.
 * It shares the production backend adapter and durable conversation writer with
 * interactive chat while intentionally exposing no Mivlet tools or approval gate.
 */
export class AgentRunService {
  async runScheduledResearch(
    input: ScheduledResearchRunInput,
  ): Promise<ScheduledResearchRunResult> {
    ensureCurrent(input);
    if (
      input.provider.id !== input.providerId ||
      input.provider.backendType !== "codex-app-server" ||
      input.provider.authState !== "connected" ||
      !input.provider.capabilities.includes("streaming")
    ) {
      throw new Error(
        "This schedule requires its original connected Codex provider.",
      );
    }
    if (
      input.modelDefinition.id !== input.model ||
      !input.modelDefinition.available ||
      input.modelDefinition.capabilities?.streaming === false
    ) {
      throw new Error("This schedule's original Codex model is unavailable.");
    }

    const backend = resolveAgentBackend(input.provider, deps());
    if (!backend)
      throw new Error("The scheduled Codex research runtime is unavailable.");

    const createdAt = new Date().toISOString();
    const contextPrefix = [
      agentExecutionInstructions(input.agent),
      SCHEDULED_RESEARCH_INSTRUCTIONS,
    ]
      .filter(Boolean)
      .join("\n\n");
    const request = {
      model: input.model,
      reasoningEffort: input.agent.reasoningEffort,
      messages: [{ role: "user" as const, content: input.prompt }],
      tools: [],
      maxTokens: 2_048,
    };
    const plan = await planConversationContext({
      history: [],
      request,
      contextPrefix,
      contextWindowTokens: input.modelDefinition.capabilities?.contextWindow,
      backendType: input.provider.backendType,
    });
    if (!plan.ok) throw new Error(plan.message);

    ensureCurrent(input);
    const thread = await createRuntimeConversationThread(
      {
        authorityScope: {
          authority: "local",
          visibility: "member-private",
          ownerMemberId: "current-member" as never,
        },
        title: "Scheduled web research",
      },
      input.workspaceId,
    );
    ensureCurrent(input);
    const threadId = thread.id as string;

    const writer = createDesktopDurableRunWriter(threadId, input.attemptId);
    // Persist the frozen user request before the native bind. The schedule
    // boundary verifies this evidence against its encrypted occurrence payload
    // before any provider egress is allowed.
    const initialExchanges: ExecutionExchange[] = [
      { role: "user", content: input.prompt },
    ];
    let attempt: ExecutionAttempt = {
      id: input.attemptId,
      providerId: input.providerId,
      model: input.model,
      status: "queued",
      transcript: "",
      threadId,
      exchanges: initialExchanges,
      contextReceipt: {
        version: 1,
        attemptId: input.attemptId,
        assembledAt: createdAt,
        scope: { level: "thread", threadId: thread.id },
        citations: [],
        contributions: [],
      },
      turn: 0,
      pendingApprovalIds: [],
      recoverable: true,
      retryCount: 0,
      createdAt,
      updatedAt: createdAt,
    };

    ensureCurrent(input);
    await saveRuntimeExecutionAttempt(attempt, input.workspaceId);
    ensureCurrent(input);
    try {
      await input.onQueued(attempt);
    } catch (error) {
      attempt = {
        ...attempt,
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "The scheduled occurrence could not start.",
        updatedAt: new Date().toISOString(),
      };
      if (
        input.isCurrent() &&
        getActiveRuntimeDataScope()?.workspaceId === input.workspaceId
      ) {
        await saveRuntimeExecutionAttempt(attempt, input.workspaceId).catch(
          () => undefined,
        );
      }
      throw error;
    }
    ensureCurrent(input);
    input.onThreadCreated?.(threadId);
    await writer.record({ kind: "user", content: input.prompt });
    ensureCurrent(input);
    attempt = {
      ...attempt,
      status: "streaming",
      exchanges: [{ role: "user", content: input.prompt }],
      updatedAt: new Date().toISOString(),
    };
    await saveRuntimeExecutionAttempt(attempt, input.workspaceId);
    ensureCurrent(input);

    const eventStream = backend.run(
      { ...request, messages: plan.messages },
      {
        execute: async () => {
          throw new Error(
            "Scheduled work needs your approval in an open conversation.",
          );
        },
        authorize: async () => {
          throw new Error(
            "Scheduled work needs your approval in an open conversation.",
          );
        },
        contextPrefix,
        permissionMode: "read-only",
        attemptId: input.attemptId,
        maxToolCalls: 1,
        onRetry: () => {
          attempt = {
            ...attempt,
            status: "retrying",
            retryCount: attempt.retryCount + 1,
            updatedAt: new Date().toISOString(),
          };
        },
      },
    );
    if (!eventStream) {
      const message = "The scheduled Codex research runtime is unavailable.";
      attempt = {
        ...attempt,
        status: "failed",
        recoverable: true,
        error: message,
        updatedAt: new Date().toISOString(),
      };
      ensureCurrent(input);
      await writer.record({
        kind: "error",
        content: message,
        code: "scheduled-research-unavailable",
        retryable: false,
      });
      ensureCurrent(input);
      await saveRuntimeExecutionAttempt(attempt, input.workspaceId);
      return { terminal: "failed", attempt, threadId, message };
    }
    input.onBackendReady?.(() => backend.cancel(input.attemptId));

    let needsUser = false;
    let failure: string | undefined;
    let completed = false;
    try {
      for await (const event of eventStream) {
        ensureCurrent(input);
        if (event.type === "text-delta") {
          attempt = {
            ...attempt,
            status: "streaming",
            transcript: attempt.transcript + event.text,
            exchanges: appendAssistant(attempt.exchanges ?? [], event.text),
            updatedAt: new Date().toISOString(),
          };
          await writer.checkpointAssistant(attempt.transcript);
          ensureCurrent(input);
          input.onProgress?.({ threadId, transcript: attempt.transcript });
        } else if (event.type === "reasoning-summary") {
          const key = `${event.itemId}:${event.summaryIndex}`;
          attempt = {
            ...attempt,
            reasoningSummaries: {
              ...(attempt.reasoningSummaries ?? {}),
              [key]:
                `${attempt.reasoningSummaries?.[key] ?? ""}${event.text}`.slice(
                  -16_000,
                ),
            },
            updatedAt: new Date().toISOString(),
          };
        } else if (event.type === "provider-tool") {
          if (event.tool !== "web-search") {
            needsUser = true;
            failure =
              "Scheduled research stopped because Codex requested work outside web search.";
            await backend.cancel(input.attemptId);
            break;
          }
          input.onProgress?.({
            threadId,
            transcript: attempt.transcript,
            activity:
              event.status === "running" ? "Searching the web" : undefined,
          });
          if (event.status === "running") {
            await writer.record({
              kind: "tool-call",
              content: event.arguments,
              callId: event.callId,
              toolName: event.tool,
            });
            ensureCurrent(input);
          } else {
            const ok = event.status === "succeeded";
            const output = event.output ?? "";
            attempt = {
              ...attempt,
              turn: attempt.turn + 1,
              exchanges: [
                ...(attempt.exchanges ?? []),
                {
                  role: "tool",
                  content: output,
                  toolCallId: event.callId,
                  toolName: event.tool,
                  ok,
                },
              ],
              updatedAt: new Date().toISOString(),
            };
            await writer.record({
              kind: "tool-result",
              content: output,
              callId: event.callId,
              toolName: event.tool,
              ok,
            });
            ensureCurrent(input);
          }
        } else if (
          event.type === "tool-call" ||
          (event.type === "tool-result" && !event.ok)
        ) {
          needsUser = true;
          failure =
            "Scheduled research stopped because it needs your approval.";
          await backend.cancel(input.attemptId);
          break;
        } else if (event.type === "usage") {
          attempt = {
            ...attempt,
            usage: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd,
              costEstimated: event.costEstimated,
              costUnknown: event.costUnknown,
            },
            updatedAt: new Date().toISOString(),
          };
        } else if (event.type === "error") {
          const described = describeBackendError(
            event.message,
            event.code,
            event.retryable,
          );
          failure = described.message;
          break;
        } else if (event.type === "cancelled") {
          failure = "Scheduled research was interrupted.";
          break;
        } else if (event.type === "done") {
          completed = event.finishReason !== "error";
          if (!completed)
            failure = "Scheduled research failed before it completed.";
          break;
        }
      }
    } catch (error) {
      failure =
        error instanceof Error ? error.message : "Scheduled research failed.";
    }

    const terminal: ScheduledResearchTerminal = needsUser
      ? "needs-user"
      : completed
        ? "completed"
        : failure === "Scheduled research was interrupted."
          ? "interrupted"
          : "failed";
    attempt = {
      ...attempt,
      status:
        terminal === "completed"
          ? "completed"
          : terminal === "failed"
            ? "failed"
            : "interrupted",
      recoverable: terminal !== "completed",
      pendingApprovalIds: [],
      ...(failure ? { error: failure } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (terminal === "completed") {
      ensureCurrent(input);
      await writer.checkpointAssistant(attempt.transcript, true);
    } else if (terminal === "failed") {
      ensureCurrent(input);
      await writer.record({
        kind: "error",
        content: failure ?? "Scheduled research failed.",
        code: "scheduled-research-failed",
        retryable: false,
      });
    } else {
      ensureCurrent(input);
      await writer.record({
        kind: "interruption",
        content: failure ?? "Scheduled research stopped.",
        reason: "policy-stop",
      });
    }
    ensureCurrent(input);
    await saveRuntimeExecutionAttempt(attempt, input.workspaceId);
    return { terminal, attempt, threadId, message: failure };
  }
}
