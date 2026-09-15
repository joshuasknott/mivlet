import { baseRequest,connectedCodexProvider,connectedOpenAiProvider,finishStop,installDesktopRuntime,mocks,openAiChunk } from "./native-agent-test-harness";
import { createApprovalGate } from "@mivlet/connectors";
import type {
BackendAgentEvent,
BackendProvider,
ExecutionAttempt
} from "@mivlet/protocol";
import { act,renderHook,waitFor } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import type { DurableRunWriter } from "../lib/conversation-runtime";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";

import { useNativeAgent } from "./useNativeAgent";

describe("native agent providers", () => {
  it("surfaces noTransport and an error when no desktop runtime is present", async () => {
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [{ id: "openai" } as never] }),
    );

    // The initial state reflects the missing runtime.
    expect(result.current.state.noTransport).toBe(true);

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.noTransport).toBe(true);
    expect(result.current.state.lastError).toBe(
      "Native agent needs the desktop runtime.",
    );
    expect(result.current.state.running).toBe(false);
    // No transport means no stream ever started.
    expect(mocks.streamCalls).toBe(0);
  });

  it("resolves an already-connected backend independently of the active picker", async () => {
    const anthropic: BackendProvider = {
      ...connectedOpenAiProvider(),
      id: "anthropic",
      label: "Anthropic",
      description: "Anthropic API",
      models: [
        { id: "claude-sonnet-4", label: "Claude Sonnet 4", available: true },
      ],
    };
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider(), anthropic],
        activeProviderId: "openai",
      }),
    );

    await waitFor(() =>
      expect(result.current.backend?.providerId).toBe("openai"),
    );
    expect(result.current.resolveBackend("anthropic")?.providerId).toBe(
      "anthropic",
    );
    expect(result.current.resolveBackend("missing")).toBeNull();
  });

  it("accumulates text-delta events into the transcript", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Hello"), openAiChunk(" world"), finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    expect(result.current.state.noTransport).toBe(false);
    expect(result.current.state.running).toBe(false);

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.transcript).toBe("Hello world");
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
    const finalRun = mocks.savedRuns.at(-1) as ExecutionAttempt;
    expect(finalRun.status).toBe("completed");
    expect(finalRun.exchanges).toEqual([
      {
        role: "user",
        content: "summarize the conversation",
        toolCallId: undefined,
        toolName: undefined,
      },
      { role: "assistant", content: "Hello world" },
    ]);
  });

  it("captures usage events into the usage state", async () => {
    installDesktopRuntime();
    mocks.lines = [
      openAiChunk("ok"),
      'data: {"usage":{"prompt_tokens":42,"completion_tokens":7}}',
      finishStop,
    ];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.usage).not.toBeNull();
    expect(result.current.state.usage?.inputTokens).toBe(42);
    expect(result.current.state.usage?.outputTokens).toBe(7);
    expect(
      result.current.state.usageReceipts[
        result.current.state.currentAttemptId ?? ""
      ],
    ).toMatchObject({
      inputTokens: 42,
      outputTokens: 7,
    });
    // costUsd is provider-priced; just assert it is a finite number.
    expect(Number.isFinite(result.current.state.usage?.costUsd ?? NaN)).toBe(
      true,
    );
  });

  it("routes tool-call events to the onToolCall callback", async () => {
    installDesktopRuntime();
    mocks.lines = [
      // A model-emitted tool call. The parser builds an ApprovalRequest for it.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    ];

    const onToolCall = vi.fn();
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()], onToolCall }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    // The loop emitted a tool-call event; the hook routed it to onToolCall with
    // the pre-shaped ApprovalRequest (service = providerId, registered tool).
    const toolEvent = onToolCall.mock.calls.at(0)?.at(0) as Extract<
      BackendAgentEvent,
      { type: "tool-call" }
    >;
    expect(toolEvent).toBeDefined();
    expect(toolEvent.type).toBe("tool-call");
    expect(toolEvent.callId).toBe("call_1");
    expect(toolEvent.tool).toBe("read-file");
    expect(toolEvent.approval.service).toBe("openai");
    // The hook never auto-executes: the stub executor throws, which surfaces as
    // a failed tool-result inside the loop — but the tool-call still routes and
    // the attempt still finishes.
    expect(result.current.state.running).toBe(false);
  });

  it("renders and persists provider-owned tool activity without invoking Mivlet's tool callback", async () => {
    installDesktopRuntime();
    const output = JSON.stringify({
      untrusted: true,
      results: [{ title: "Release notes", url: "https://example.com/release" }],
    });
    mocks.codexEvents = [
      {
        type: "provider-tool",
        callId: "search-1",
        tool: "web-search",
        arguments: '{"query":"current release"}',
        status: "running",
      },
      {
        type: "provider-tool",
        callId: "search-1",
        tool: "web-search",
        arguments: '{"query":"current release"}',
        status: "succeeded",
        output,
      },
      { type: "done", finishReason: "stop" },
    ];
    const onToolCall = vi.fn();
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedCodexProvider()],
        threadId: "thread-provider-tool",
        onToolCall,
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(onToolCall).not.toHaveBeenCalled();
    expect(mocks.toolRequests).toEqual([]);
    expect(result.current.state.responseParts).toContainEqual(
      expect.objectContaining({
        id: "search-1",
        kind: "tool",
        tool: "web-search",
        content: output,
        state: "succeeded",
      }),
    );
    expect(record.mock.calls.map(([entry]) => entry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool-call",
          callId: "search-1",
          toolName: "web-search",
        }),
        expect.objectContaining({
          kind: "tool-result",
          callId: "search-1",
          toolName: "web-search",
          ok: true,
          content: output,
        }),
      ]),
    );
    const saved = mocks.savedRuns.at(-1) as ExecutionAttempt;
    expect(saved.exchanges).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "search-1",
        toolName: "web-search",
        ok: true,
        content: output,
      }),
    );
  });

  it("records error events into lastError without crashing the loop", async () => {
    installDesktopRuntime();
    // An unparseable chunk yields an error event from the parser, then a clean
    // stop keeps the loop finishing normally.
    mocks.lines = ["data: not-valid-json", finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.lastError).toBe("Unparseable OpenAI chunk.");
    expect(result.current.state.running).toBe(false);
  });

  it("clears running and resets the transcript at the start of each run", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("first"), finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });
    expect(result.current.state.transcript).toBe("first");

    mocks.lines = [openAiChunk("second"), finishStop];
    await act(async () => {
      await result.current.run(baseRequest);
    });

    // Each run resets the transcript/usage/error and only keeps this run's text.
    expect(result.current.state.transcript).toBe("second");
    expect(result.current.state.usage).toBeNull();
    expect(result.current.state.lastError).toBeNull();
  });

  it("threads the permission-level label into the loop and still completes the attempt", async () => {
    installDesktopRuntime();
    // A write-file tool call (defaultMode full-access). Under read-only the loop
    // refuses it before the (stub) executor runs, then continues to a stop. The
    // deep deny semantics are covered at the agent-loop level; here we verify the
    // label is accepted, threaded through, and the attempt completes without throwing.
    mocks.lines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write-file","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"x\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      // Second turn: a clean stop so the loop finishes after the denied tool.
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
    ];

    const onToolCall = vi.fn();
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()], onToolCall }),
    );

    await act(async () => {
      // Read-only is accepted and threaded into the attempt.
      await result.current.run(baseRequest, undefined, "read-only");
    });

    // The write-file tool call surfaced to the shell (read-only gates execution,
    // not visibility), and the attempt finished cleanly.
    const toolEvent = onToolCall.mock.calls.at(0)?.at(0) as Extract<
      BackendAgentEvent,
      { type: "tool-call" }
    >;
    expect(toolEvent?.tool).toBe("write-file");
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
  });

  it("joins the executor + gate + Rust boundary: tool-call -> register -> grant -> execute -> ok result", async () => {
    // The missing joined seam. This proves in one place that:
    //   - the execute option is createDesktopToolExecutor backed by a REAL
    //     ProductionApprovalGate (from @mivlet/connectors);
    //   - executeRuntimeToolCall (../runtime) is mocked to a scripted result and
    //     records its inputs;
    //   - a read-file tool-call surfaces -> onToolCall registers on the gate
    //     (mirroring App.tsx) -> a grant drives the executor -> the mocked Rust
    //     boundary is invoked with {tool, arguments, approval} -> an ok
    //     tool-result is produced and the loop continues to a stop.
    installDesktopRuntime();
    mocks.lines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    ];
    // Turn 2: a clean stop so the loop finishes after the granted tool runs.
    mocks.turnTwoLines = [
      'data: {"choices":[{"delta":{"content":"done"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
    ];
    // Script the mocked Rust boundary to return the file body.
    mocks.toolResult = { ok: true, output: "Mivlet rocks" };

    // Real gate + real desktop executor (awaits the gate, then calls the Rust
    // boundary — which is mocked here). This is exactly what App.tsx wires.
    const gate = createApprovalGate();
    let markExecuting: (id: string, tool: string) => void = () => {};
    let completeNative!: () => void;
    const pendingNative = new Promise<void>((resolve) => {
      completeNative = resolve;
    });
    const { executeRuntimeToolCall } = await import("../runtime/domains/tools");
    vi.mocked(executeRuntimeToolCall).mockImplementationOnce(
      async (request) => {
        mocks.toolRequests.push(request);
        await pendingNative;
        return mocks.toolResult;
      },
    );
    const executor = createDesktopToolExecutor(gate, {
      onExecuting: (approval, tool) => markExecuting(approval.id, tool),
      localComputer: {
        workspaceId: "workspace-test",
        agentId: "agent-test",
        ready: true,
        generation: 1,
        controller: "agent",
      },
      queueApproval: (approval) => {
        registeredApproval = approval;
        gate.register(approval);
      },
    });

    let registeredApproval:
      Extract<BackendAgentEvent, { type: "tool-call" }>["approval"] | null =
      null;
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        execute: executor,
        // Computer approvals are queued by the executor after scope/epoch binding.
        onToolCall: () => undefined,
      }),
    );
    markExecuting = result.current.markToolExecuting;

    // Kick off the attempt, then grant the tool call once it surfaces. The executor
    // blocks on the gate until the grant, so run + grant interleave.
    let runPromise!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });
    // Wait for the tool-call to surface + be registered on the gate, then grant
    // it by the approval id the parser assigned (not the model callId).
    await waitFor(() => expect(registeredApproval).not.toBeNull());
    const approvalId = registeredApproval!.id;
    await waitFor(() => expect(gate.hasPending(approvalId)).toBe(true));
    // Grant the pending call — the executor unblocks and runs the tool.
    gate.resolveGrant(approvalId);

    await waitFor(() => {
      expect(result.current.state.activity).toBe("Reading a file");
      expect(result.current.state.status).toBe("streaming");
    });
    expect(result.current.state.running).toBe(true);
    completeNative();

    await act(async () => {
      await runPromise;
    });

    // The mocked Rust boundary was invoked once with the right shape: the
    // registered tool, the parsed arguments, and a once-decision approval whose
    // request matches the surfaced tool call (defense in depth).
    expect(mocks.toolRequests).toHaveLength(1);
    const toolRequest = mocks.toolRequests[0] as {
      tool: string;
      arguments: { path: string };
      approval: {
        decision: string;
        request: { action: string; service: string };
      };
    };
    expect(toolRequest.tool).toBe("read-file");
    expect(toolRequest.arguments).toEqual({ path: "README.md" });
    expect(toolRequest.approval.decision).toBe("once");
    expect(toolRequest.approval.request.action).toContain("read-file");
    expect(toolRequest.approval.request.service).toBe("openai");

    // The attempt finished cleanly (the loop continued past the tool turn to done),
    // the gate is no longer holding the call, and no error surfaced.
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
    expect(gate.pendingCount()).toBe(0);
  });

  it.each([
    {
      name: "openai (openai-compat shaper)",
      providerId: "openai",
      model: "gpt-5",
      // OpenAI chat-completions: choices/delta content + a top-level "messages".
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("gpt-5");
        expect(body.stream).toBe(true);
        // Chat-completions uses "messages"; Anthropic also does but without the
        // "system" sibling and with max_tokens (asserted per-provider below).
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
    {
      name: "anthropic (messages shaper)",
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
      // Anthropic streams event/data pairs; a content_block_delta text + a
      // message_delta stop closes the turn.
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        'data: {"type":"message_stop"}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("claude-sonnet-4-6");
        expect(body.max_tokens).toBeDefined();
        // Anthropic's signature: stream + messages, NO stream_options/choices.
        expect(body.stream).toBe(true);
        expect(body.stream_options).toBeUndefined();
      },
    },
    {
      name: "gemini (generateContent shaper)",
      providerId: "gemini",
      model: "gemini-2.5-pro",
      // Gemini streams JSON-per-line with candidates/parts.
      lines: [
        '{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}',
        '{"candidates":[{"finishReason":"STOP"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(Array.isArray(body.contents)).toBe(true);
        // Gemini's signature: generationConfig + contents, NO model/messages.
        expect(body.generationConfig).toBeDefined();
        expect(body.model).toBeUndefined();
        expect(body.messages).toBeUndefined();
      },
    },
    {
      name: "xai (openai-compat shaper)",
      providerId: "xai",
      model: "grok-4",
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("grok-4");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
    {
      name: "openrouter (openai-compat shaper)",
      providerId: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      // OpenRouter chat-completions streams end with a usage chunk that repeats
      // the finish_reason on a content-free delta (documented deviation); the
      // loop must treat it as an accounting frame, not a second terminal event.
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("anthropic/claude-sonnet-4.6");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
    {
      name: "custom endpoint (openai-compat shaper)",
      providerId: "custom",
      model: "custom-chat",
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("custom-chat");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
  ])(
    "routes $name through the desktop transport with the provider-shaped body",
    async ({ providerId, model, lines, expectBody }) => {
      installDesktopRuntime();
      mocks.lines = lines;

      // Resolve a connected native-API provider matching this case so the hook
      // builds the right backend; the providerId threads through to the Rust
      // boundary (the key + endpoint are resolved from it inside Rust).
      const provider: BackendProvider = {
        id: providerId,
        backendType: "native-api",
        label: providerId,
        description: `${providerId} API`,
        authState: "connected",
        capabilities: [
          "authentication",
          "streaming",
          "tool-requests",
          "approvals",
          "cancellation",
        ],
        models: [{ id: model, label: model, available: true }],
      };
      const { result } = renderHook(() =>
        useNativeAgent({ providers: [provider] }),
      );

      await act(async () => {
        await result.current.run({
          model,
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          maxTokens: 512,
        });
      });

      // The desktop transport made exactly one egress call for the attempt.
      expect(mocks.streamRequests).toHaveLength(1);
      const egress = mocks.streamRequests[0];
      // The providerId + selected model thread through to the Rust boundary
      // (the key + endpoint are resolved from providerId inside Rust).
      expect(egress.providerId).toBe(providerId);
      expect(egress.model).toBe(model);
      // The body was shaped by this provider's shaper (the assertion above).
      expectBody(egress.body as Record<string, unknown>);
      // The attempt completed without surfacing an error.
      expect(result.current.state.running).toBe(false);
      expect(result.current.state.lastError).toBeNull();
    },
  );

  it("routes through the provider selected by the combined model picker", async () => {
    installDesktopRuntime();
    mocks.lines = [
      'data: {"choices":[{"delta":{"content":"selected"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
    ];
    const xai: BackendProvider = {
      ...connectedOpenAiProvider(),
      id: "xai",
      label: "xAI",
      models: [{ id: "grok-4", label: "Grok 4", available: true }],
    };
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider(), xai],
        activeProviderId: "xai",
      }),
    );

    await act(async () => {
      await result.current.run({ ...baseRequest, model: "grok-4" });
    });

    expect(mocks.streamRequests).toHaveLength(1);
    expect(mocks.streamRequests[0]).toMatchObject({
      providerId: "xai",
      model: "grok-4",
    });
  });

  it("provider errors surface into lastError through the transport control channel", async () => {
    installDesktopRuntime();
    // The desktop transport parses `__mivletTransport` control lines: a `{ kind:
    // "error" }` from Rust sets transportError, which the transport re-throws so
    // the loop surfaces it as a lastError. Here the listener feeds that control
    // line (no provider payload, no [DONE]) to prove the error path.
    mocks.lines = [
      JSON.stringify({
        __mivletTransport: {
          kind: "error",
          code: "authentication",
          message: "Provider rejected the API key.",
          retryable: false,
          attempt: 1,
          retryAfterMs: null,
        },
      }),
    ];
    // emitDone stays true, but the transport error short-circuits the attempt.

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.running).toBe(false);
    // The error is classified so a configuration failure (rejected/expired key)
    // is distinguishable from an attempttime/provider failure: the surfaced message
    // points the user at their key in Settings and preserves the provider detail.
    expect(result.current.state.lastError).toContain("API key");
    expect(result.current.state.lastError).toContain("Settings");
    expect(result.current.state.lastError).toContain(
      "Provider rejected the API key.",
    );
  });

  it("runtime provider errors are classified as retryable, not as a key problem", async () => {
    installDesktopRuntime();
    // A 5xx surfaces as `provider-unavailable` — an attempttime failure, not a
    // configuration one. The surfaced message must not point at the API key.
    mocks.lines = [
      JSON.stringify({
        __mivletTransport: {
          kind: "error",
          code: "provider-unavailable",
          message: "Provider request failed with HTTP 503.",
          retryable: true,
          attempt: 3,
          retryAfterMs: null,
        },
      }),
    ];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toContain("unavailable");
    expect(result.current.state.lastError).toContain("HTTP 503");
    // A runtime error must never be mislabeled as an API-key problem.
    expect(result.current.state.lastError?.toLowerCase()).not.toContain(
      "api key",
    );
  });
});
