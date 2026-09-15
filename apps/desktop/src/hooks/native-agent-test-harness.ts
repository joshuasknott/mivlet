import type {
AgentTurnRequest,
BackendProvider,
ExecutionAttempt,
PreparedExecutionContext
} from "@mivlet/protocol";
import { beforeEach,vi } from "vitest";
import { listRuntimeContextSummaries,saveRuntimeContextSummary } from "../runtime/domains/memory";

// This suite retains the direct wire-family and provider-owned runtime coverage.
// The embedded production bridge is exercised in useNativeAgent.embedded.test.tsx.
vi.mock("../lib/embedded-agent", () => ({ createDesktopEmbeddedRuntime: undefined }));

/**
 * useNativeAgent owns the agent run/cancel loop and the event-reduction state
 * machine. Outside Tauri the hook surfaces a no-transport notice; with a faked
 * desktop runtime the internal transport yields our scripted SSE lines through
 * the real runAgentLoop, so we drive the reduction deterministically and assert
 * the exact behaviors the goal targets:
 *   - text-delta accumulation into transcript
 *   - usage capture
 *   - tool-call -> onToolCall callback
 *   - error -> lastError
 *   - done/cancelled -> running=false
 *   - noTransport when hasDesktopRuntime() is false
 *
 * No real network, Tauri, or SSE — every Rust-bound wrapper is mocked. The
 * mocked listen callback captures onLine so tests can also hold an attempt open
 * (omit [DONE]) to exercise cancellation against a genuinely in-flight loop.
 */

const mocks = vi.hoisted(() => ({
  // SSE lines to feed the transport when it subscribes.
  lines: [] as string[],
  // Optional second-turn lines: when set, the first transport subscribe replays
  // `lines` and every subsequent subscribe replays `turnTwoLines` (defaulting to
  // a clean stop). This lets multi-turn joined tests script turn 1 (tool-call)
  // and turn 2 (stop) deterministically instead of replaying the same chunks.
  turnTwoLines: null as string[] | null,
  // When false, the listener does not emit [DONE] — the attempt stays open/blocked
  // so cancellation can target an in-flight loop.
  emitDone: true,
  // The most recent onLine callback, captured so a held-open run can be settled
  // manually after assertions.
  onLine: null as ((line: string) => void) | null,
  streamCalls: 0,
  // Every RuntimeStreamRequest the mocked streamRuntimeCompletion received. The
  // desktop transport calls it once per turn with `{ providerId, requestId,
  // model, body }` where `body` is the output of shapeBodyFor(request). Capturing
  // it lets the per-provider routing tests assert that each provider's body was
  // shaped by the right shaper (anthropic/gemini/openai-compat) before egress —
  // proving the shapeBodyFor routing works end-to-end through the desktop hook.
  streamRequests: [] as Array<{
    providerId: string;
    requestId: string;
    model: string;
    body: unknown;
    providerRoute?: unknown;
  }>,
  cancelCalls: [] as string[],
  // The joined integration test scripts the mocked Rust tool boundary here:
  // every executeRuntimeToolCall records its request and resolves with this result.
  toolRequests: [] as unknown[],
  savedRuns: [] as unknown[],
  persistenceEvents: [] as string[],
  saveError: null as Error | null,
  failSaveStatus: null as ExecutionAttempt["status"] | null,
  recoveredRuns: [] as ExecutionAttempt[],
  listedRuns: null as ExecutionAttempt[] | null,
  codexEvents: [] as unknown[],
  codexListener: null as ((event: unknown) => void) | null,
  toolResult: { ok: true, output: "Fetched body text from Rust." },
  selectRoute: vi.fn(async (input: { providerId: string; model: string }) => ({
    workspaceId: "workspace-1",
    selection: {
      providerRouteId: `route-${input.providerId}-${input.model}`,
      selectedAt: "2026-07-12T12:00:00.000Z",
      reason: `Selected ${input.providerId} ${input.model}.`,
      boundaryPolicyRef: `boundary-${input.providerId}`,
    },
  })),
}));

vi.mock("../lib/provider-route-selection", () => ({
  selectNativeProviderRoute: mocks.selectRoute,
}));

vi.mock("../runtime/domains/providers", () => ({
listenRuntimeBackendEvents: vi.fn(
    async (_requestId: string, onLine: (line: string) => void) => {
      mocks.onLine = onLine;
      const subscribeCount = ++listenCount;
      // Turn 1 plays `lines`; turn 2+ plays `turnTwoLines` (a clean stop by default)
      // so a multi-turn run does not replay the tool-call chunks each turn.
      const replay =
        subscribeCount > 1 && mocks.turnTwoLines !== null
          ? mocks.turnTwoLines
          : mocks.lines;
      for (const line of replay) {
        onLine(line);
      }
      if (mocks.emitDone) {
        onLine("[DONE]");
      }
      return () => {};
    },
  ),
streamRuntimeCompletion: vi.fn(
    async (request: {
      providerId: string;
      requestId: string;
      model: string;
      body: unknown;
      providerRoute?: unknown;
    }) => {
      mocks.streamCalls += 1;
      mocks.persistenceEvents.push("egress");
      // Record the egress request so the per-provider routing tests can assert
      // the body was shaped by the correct shaper before crossing to Rust.
      mocks.streamRequests.push(request);
      return null;
    },
  ),
cancelRuntimeCompletion: vi.fn(async (requestId: string) => {
    mocks.cancelCalls.push(requestId);
    return null;
  }),
listRuntimeBackendModels: vi.fn(async () => null),
listenRuntimeCodexEvents: vi.fn(
    async (_requestId: string, onEvent: (event: unknown) => void) => {
      mocks.codexListener = onEvent;
      return () => {
        mocks.codexListener = null;
      };
    },
  ),
startRuntimeCodexTurn: vi.fn(async () => {
    for (const event of mocks.codexEvents) mocks.codexListener?.(event);
    return null;
  }),
respondRuntimeCodexApproval: vi.fn(async () => null),
interruptRuntimeCodexTurn: vi.fn(async () => null),
shutdownRuntimeCodexTurn: vi.fn(async () => null),
getRuntimeCodexStatus: vi.fn(async () => ({
    installed: true,
    authenticated: true,
    authMethod: "chatgpt",
  }))
}));
vi.mock("../runtime/domains/workspace", () => ({
saveRuntimeExecutionAttempt: vi.fn(async (run: unknown) => {
    if (mocks.saveError) throw mocks.saveError;
    if (
      mocks.failSaveStatus &&
      (run as ExecutionAttempt).status === mocks.failSaveStatus
    )
      throw new Error("final persistence unavailable");
    mocks.savedRuns.push(run);
    mocks.persistenceEvents.push("save");
    return run;
  }),
recoverRuntimeExecutionAttempts: vi.fn(async () => mocks.recoveredRuns),
listRuntimeExecutionAttempts: vi.fn(async () => mocks.listedRuns)
}));
vi.mock("../runtime/domains/memory", () => ({
listRuntimeContextSummaries: vi.fn(async () => null),
saveRuntimeContextSummary: vi.fn(async (summary: unknown) => summary)
}));
vi.mock("../runtime/domains/tools", () => ({
executeRuntimeToolCall: vi.fn(async (request: unknown) => {
    mocks.toolRequests.push(request);
    return mocks.toolResult;
  })
}));

// Tracks the number of transport subscribes so the mock can serve different
// lines per turn (declared outside the hoisted block so it is mutable + reset).
let listenCount = 0;

/** Set window.__TAURI_INTERNALS__ so hasDesktopRuntime() returns true. */
export function installDesktopRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke: {} },
    configurable: true,
    writable: true,
  });
}

/** Clear any faked desktop runtime so hasDesktopRuntime() returns false. */
function removeDesktopRuntime() {
  try {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  } catch {}
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
    undefined;
}

export const baseRequest: AgentTurnRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "summarize the conversation" }],
  tools: [],
  maxTokens: 1024,
};

export const preparedContext: PreparedExecutionContext = {
  systemPrefix: "Use the selected conversation notes.",
  receipt: {
    version: 1,
    attemptId: "019f4f00-0000-7000-8000-contextreceipt",
    assembledAt: "2026-07-11T12:00:00.000Z",
    scope: { level: "thread", threadId: "thread-1" },
    citations: [],
    contributions: [
      { id: "memory-1", kind: "memory", reason: "memory-approved" },
    ],
  },
};

/** A connected, streaming native-API provider the hook can resolve to a backend. */
export function connectedOpenAiProvider(): BackendProvider {
  return {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "connected",
    capabilities: [
      "authentication",
      "streaming",
      "tool-requests",
      "approvals",
      "cancellation",
    ],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }],
  };
}

export function connectedCodexProvider(): BackendProvider {
  return {
    id: "codex",
    backendType: "codex-app-server",
    label: "Codex",
    description: "Codex app-server",
    authState: "connected",
    capabilities: [
      "authentication",
      "threads",
      "streaming",
      "tool-requests",
      "approvals",
      "cancellation",
    ],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }],
  };
}

export function openAiChunk(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}`;
}
export const finishStop = 'data: {"choices":[{"finish_reason":"stop"}]}';

function resetLineState() {
  mocks.lines = [];
  mocks.turnTwoLines = null;
  mocks.emitDone = true;
  mocks.onLine = null;
  mocks.streamCalls = 0;
  mocks.streamRequests = [];
  mocks.cancelCalls = [];
  mocks.toolRequests = [];
  mocks.savedRuns = [];
  mocks.persistenceEvents = [];
  mocks.saveError = null;
  mocks.failSaveStatus = null;
  mocks.recoveredRuns = [];
  mocks.listedRuns = null;
  mocks.codexEvents = [];
  mocks.codexListener = null;
  mocks.toolResult = { ok: true, output: "Fetched body text from Rust." };
  listenCount = 0;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetLineState();
    removeDesktopRuntime();
    // Compaction stays unavailable by default; individual tests opt in with
    // durable summaries so a previous test's mock implementation cannot leak.
    vi.mocked(listRuntimeContextSummaries).mockResolvedValue(null);
    vi.mocked(saveRuntimeContextSummary).mockImplementation(
      async (summary) => summary,
    );
  });
export { mocks };
