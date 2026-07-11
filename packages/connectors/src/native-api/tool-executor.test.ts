import { describe, expect, it } from "vitest";
import type { ApprovalGrant, ApprovalRequest, PermissionMode } from "@fable/protocol";
import type { HttpTransport } from "./transport";
import { runAgentLoop } from "./agent-loop";
import { registeredToolSpecs } from "./tools";
import {
  createApprovalGate,
  createToolExecutor,
  type ApprovalGate,
  type DecisionResult,
  type ToolRuntime
} from "./tool-executor";

/**
 * TDD coverage for the pure tool executor + its grant gate. The executor never
 * touches the filesystem or a shell directly — every capability flows through an
 * injectable ToolRuntime, so these tests run against a fake filesystem + fake
 * shell + fake fetch and assert real grant-gating behavior.
 *
 * The five required behaviors:
 *   (a) read-file executes after a once grant and returns content to the loop
 *   (b) write-file/run-shell refuse without an actual grant (high/critical risk)
 *   (c) deny does not execute (no side effect)
 *   (d) a session grant auto-satisfies the next matching call without re-prompt
 *   (e) executor errors surface as rejected promises (the loop turns them into
 *       tool-role error messages it continues from)
 *
 * Plus a multi-turn integration test proving an approved read-file's content
 * reaches the next model turn as a tool-result message.
 */

// ---------------------------------------------------------------------------
// Test doubles.
// ---------------------------------------------------------------------------

function approvalFor(
  id: string,
  tool: string,
  over: Partial<ApprovalRequest> = {}
): ApprovalRequest {
  const base: Record<string, ApprovalRequest> = {
    "read-file": {
      id,
      service: "openai",
      action: `read-file path: ${over.action?.includes("other") ? "other.txt" : "x.txt"}`,
      mode: "read-only",
      riskLevel: "low",
      dataUsed: ["path: x.txt"],
      consequence: "Execute the read-file tool via openai with the given arguments.",
      requestedAt: new Date(0).toISOString(),
      decisions: ["once", "session", "rule", "modify", "deny"]
    },
    "write-file": {
      id,
      service: "openai",
      action: "write-file path: y.txt content: hi",
      mode: "full-access",
      riskLevel: "high",
      dataUsed: ["path: y.txt", "content: hi"],
      consequence: "Execute the write-file tool via openai with the given arguments.",
      requestedAt: new Date(0).toISOString(),
      decisions: ["once", "session", "rule", "modify", "deny"],
      confirmationPhrase: "approve write-file"
    },
    "run-shell": {
      id,
      service: "openai",
      action: "run-shell command: ls",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["command: ls"],
      consequence: "Execute the run-shell tool via openai with the given arguments.",
      requestedAt: new Date(0).toISOString(),
      decisions: ["once", "session", "rule", "modify", "deny"],
      confirmationPhrase: "approve run-shell"
    },
    "web-fetch": {
      id,
      service: "openai",
      action: "web-fetch url: https://x.test",
      mode: "read-only",
      riskLevel: "medium",
      dataUsed: ["url: https://x.test"],
      consequence: "Execute the web-fetch tool via openai with the given arguments.",
      requestedAt: new Date(0).toISOString(),
      decisions: ["once", "session", "rule", "modify", "deny"]
    }
  };
  return { ...base[tool], ...over };
}

function argsFor(tool: string): string {
  switch (tool) {
    case "read-file":
      return JSON.stringify({ path: "x.txt" });
    case "write-file":
      return JSON.stringify({ path: "y.txt", content: "hi" });
    case "run-shell":
      return JSON.stringify({ command: "ls" });
    case "web-fetch":
      return JSON.stringify({ url: "https://x.test" });
    default:
      return "{}";
  }
}

/** A recording fake runtime: in-memory fs + recorded writes/shell/fetch. */
function fakeRuntime(): ToolRuntime & {
  files: Map<string, string>;
  writes: { path: string; content: string }[];
  shellRuns: string[];
  fetched: string[];
} {
  const files = new Map<string, string>([["x.txt", "hello world"]]);
  const writes: { path: string; content: string }[] = [];
  const shellRuns: string[] = [];
  const fetched: string[] = [];
  return {
    files,
    writes,
    shellRuns,
    fetched,
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async writeFile(path, content) {
      writes.push({ path, content });
      files.set(path, content);
      return content.length;
    },
    async runShell(command) {
      shellRuns.push(command);
      return { stdout: `ran: ${command}`, stderr: "", exitCode: 0 };
    },
    async fetchUrl(url) {
      fetched.push(url);
      return `<html>${url}</html>`;
    }
  };
}

/** A minimal gate stub that resolves to a fixed decision, with no standing grants. */
function decisionGate(decision: DecisionResult): ApprovalGate {
  return { waitForDecision: async () => decision };
}

function grant(id = "g1"): ApprovalGrant {
  return {
    id,
    requestId: id,
    scope: "session",
    service: "openai",
    action: "read-file path: x.txt",
    mode: "read-only",
    dataUsed: ["path: x.txt"],
    createdAt: new Date(0).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Executor dispatch + grant gating.
// ---------------------------------------------------------------------------

describe("createToolExecutor — dispatch + grant gating", () => {
  it("(a) read-file executes after a grant and returns the file content", async () => {
    const runtime = fakeRuntime();
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    await expect(
      executor(approvalFor("c1", "read-file"), argsFor("read-file"))
    ).resolves.toBe("hello world");
  });

  it("executes web-fetch (read-only, medium risk) after a grant", async () => {
    const runtime = fakeRuntime();
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    await expect(
      executor(approvalFor("c1", "web-fetch"), argsFor("web-fetch"))
    ).resolves.toBe("<html>https://x.test</html>");
    expect(runtime.fetched).toEqual(["https://x.test"]);
  });

  it("(b) write-file runs through the runtime only after a grant (records the write)", async () => {
    const runtime = fakeRuntime();
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    const result = await executor(approvalFor("c1", "write-file"), argsFor("write-file"));
    expect(runtime.writes).toEqual([{ path: "y.txt", content: "hi" }]);
    expect(result.toLowerCase()).toContain("wrote");
  });

  it("(b) run-shell runs through the runtime only after a grant (no JS spawn)", async () => {
    const runtime = fakeRuntime();
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    const result = await executor(approvalFor("c1", "run-shell"), argsFor("run-shell"));
    expect(runtime.shellRuns).toEqual(["ls"]);
    expect(result).toContain("ran: ls");
  });

  it("(c) deny does not execute the tool — no side effect, rejects", async () => {
    const runtime = fakeRuntime();
    const executor = createToolExecutor({ runtime, gate: decisionGate("denied") });

    await expect(
      executor(approvalFor("c1", "write-file"), argsFor("write-file"))
    ).rejects.toThrow(/denied/i);
    expect(runtime.writes.length).toBe(0);
  });

  it("refuses an unregistered/unknown tool name even after a grant (fail-closed)", async () => {
    const runtime = fakeRuntime();
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    await expect(
      executor(approvalFor("c1", "read-file", { action: "rm-rf everything" }), "{}")
    ).rejects.toThrow(/unknown tool|not registered|rm-rf/i);
    expect(runtime.writes.length).toBe(0);
    expect(runtime.shellRuns.length).toBe(0);
  });

  it("read-file with a missing path argument fails (no fs read)", async () => {
    const runtime = fakeRuntime();
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    await expect(
      executor(approvalFor("c1", "read-file"), JSON.stringify({}))
    ).rejects.toThrow(/path/i);
  });
});

describe("Google native read tools", () => {
  it("registers Drive, Gmail, and Calendar read-only tools", () => {
    const tools = registeredToolSpecs().map((tool) => tool.name);

    expect(tools).toEqual(expect.arrayContaining([
      "google-drive-read",
      "gmail-read",
      "google-calendar-read"
    ]));
  });
});

describe("semantic Connection read tool", () => {
  it("advertises the provider-neutral repository capability", () => {
    const tool = registeredToolSpecs().find((candidate) => candidate.name === "connection-read");
    expect(tool).toBeDefined();
    expect(JSON.parse(tool!.parameters)).toMatchObject({
      required: ["capability", "input"],
      properties: {
        capability: {
          enum: ["source.repository.list", "software.deployment.list", "work.issue.list"]
        }
      }
    });
    expect(tool!.description.toLowerCase()).not.toContain("github");
  });
});

// ---------------------------------------------------------------------------
// Error handling.
// ---------------------------------------------------------------------------

describe("createToolExecutor — error handling", () => {
  it("(e) a runtime error rejects (the loop surfaces it as a tool-role error message)", async () => {
    const runtime = fakeRuntime();
    runtime.files.delete("x.txt"); // read-file returns null -> executor errors
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    await expect(
      executor(approvalFor("c1", "read-file"), JSON.stringify({ path: "missing.txt" }))
    ).rejects.toThrow(/not found|missing/i);
  });

  it("a non-zero shell exit rejects with the stderr/exit context", async () => {
    const runtime = fakeRuntime();
    runtime.runShell = async () => ({ stdout: "", stderr: "boom", exitCode: 2 });
    const executor = createToolExecutor({ runtime, gate: decisionGate("granted") });

    await expect(
      executor(approvalFor("c1", "run-shell"), argsFor("run-shell"))
    ).rejects.toThrow(/exit code 2|boom/i);
  });
});

// ---------------------------------------------------------------------------
// createApprovalGate — the production grant gate (standing grants + register).
// ---------------------------------------------------------------------------

describe("createApprovalGate — standing grants + register/resolve", () => {
  it("(d) a session grant auto-satisfies a matching call without re-prompting", async () => {
    const gate = createApprovalGate();
    gate.addStandingGrant(grant("g1")); // service+action+mode match the read-file approval
    const approval = approvalFor("c1", "read-file");

    expect(gate.register(approval)).toBe(false);
    const decision = await gate.waitForDecision(approval);
    expect(decision).toBe("granted");
    // No pending entry was created (auto-satisfied, never blocked).
    expect(gate.pendingCount()).toBe(0);
  });

  it("blocks (pending) when no standing grant covers the call", async () => {
    const gate = createApprovalGate();
    let resolved: DecisionResult | undefined;
    const p = gate.waitForDecision(approvalFor("c1", "read-file")).then((d) => (resolved = d));
    // Has not resolved yet — it is waiting for an explicit grant/deny.
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    expect(gate.pendingCount()).toBe(1);

    gate.resolveGrant("c1"); // grant via approval id (the callId)
    await p;
    expect(resolved).toBe("granted");
  });

  it("a rule grant (persisted) also auto-satisfies matching calls", async () => {
    const gate = createApprovalGate();
    gate.addStandingGrant({ ...grant("g2"), scope: "rule" });

    const decision = await gate.waitForDecision(approvalFor("c1", "read-file"));
    expect(decision).toBe("granted");
  });

  it("a standing grant does NOT match a different action (no cross-args auto-satisfy)", async () => {
    const gate = createApprovalGate();
    gate.addStandingGrant(grant("g1")); // action: "read-file path: x.txt"

    // Different file -> different action -> not covered; must block for a decision.
    const otherApproval = approvalFor("c1", "read-file", { action: "read-file path: other.txt" });
    let resolved = false;
    const p = gate.waitForDecision(otherApproval).then(() => {
      resolved = true;
    });
    // Yield to the microtask queue. A standing grant would have resolved
    // synchronously here; since it does not match, the call stays pending.
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.resolveGrant("c1");
    await p;
    expect(resolved).toBe(true);
  });

  it("a standing grant does NOT match a stricter mode (full-access grant ≠ read-only call)", async () => {
    const gate = createApprovalGate();
    // A full-access write grant must not auto-cover a read-only read-file call.
    gate.addStandingGrant({
      ...grant("g1"),
      action: "write-file path: y.txt content: hi",
      mode: "full-access" as PermissionMode
    });

    let resolved = false;
    const p = gate.waitForDecision(approvalFor("c1", "read-file")).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.resolveGrant("c1");
    await p;
    expect(resolved).toBe(true);
  });

  it("a standing grant never auto-satisfies a high-risk call", async () => {
    const gate = createApprovalGate();
    const approval = approvalFor("c1", "write-file");
    gate.addStandingGrant({
      ...grant("g-high"),
      action: approval.action,
      mode: approval.mode,
      dataUsed: approval.dataUsed
    });

    let resolved = false;
    const pending = gate.waitForDecision(approval).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.resolveGrant("c1");
    await pending;
    expect(resolved).toBe(true);
  });

  it("resolveDeny drives a pending call to denied", async () => {
    const gate = createApprovalGate();
    let resolved: DecisionResult | undefined;
    const p = gate.waitForDecision(approvalFor("c1", "read-file")).then((d) => {
      resolved = d;
    });
    gate.resolveDeny("c1");
    await p;
    expect(resolved).toBe("denied");
  });

  it("register creates the pending entry before waitForDecision is called", async () => {
    // The shell registers a pending call when the tool-call event arrives (before
    // the loop calls execute), so a grant that races the executor still resolves.
    const gate = createApprovalGate();
    expect(gate.register(approvalFor("c1", "read-file"))).toBe(true);
    expect(gate.register(approvalFor("c1", "read-file"))).toBe(false);
    expect(gate.pendingCount()).toBe(1);
    // A grant issued before anyone awaits still resolves the eventual waiter.
    gate.resolveGrant("c1");
    const decision = await gate.waitForDecision(approvalFor("c1", "read-file"));
    expect(decision).toBe("granted");
  });

  it("cancelPending tears down every pending entry (no lingering promises)", async () => {
    // A run cancelled while tool calls are registered-but-not-granted must not
    // leave the gate holding their pending entries (and their unresolved
    // promises) for the session. cancelPending rejects each pending waiter so a
    // long-running session never accumulates them.
    const gate = createApprovalGate();
    gate.register(approvalFor("c1", "read-file"));
    gate.register(approvalFor("c2", "web-fetch"));

    // Start the awaits so each has a real unresolved promise the gate holds.
    // Track rejections WITHOUT awaiting yet (they are still pending).
    const settled: { id: string; status: string }[] = [];
    void gate
      .waitForDecision(approvalFor("c1", "read-file"))
      .then(
        () => settled.push({ id: "c1", status: "resolved" }),
        () => settled.push({ id: "c1", status: "rejected" })
      );
    void gate
      .waitForDecision(approvalFor("c2", "web-fetch"))
      .then(
        () => settled.push({ id: "c2", status: "resolved" }),
        () => settled.push({ id: "c2", status: "rejected" })
      );
    // Yield once so each waiter has actually subscribed before cancel.
    await Promise.resolve();
    expect(gate.pendingCount()).toBe(2);

    gate.cancelPending();

    // The gate no longer holds either pending call.
    expect(gate.pendingCount()).toBe(0);
    expect(gate.hasPending("c1")).toBe(false);
    expect(gate.hasPending("c2")).toBe(false);

    // Let the rejection microtasks flush, then assert each waiter was rejected.
    // A couple of microtask ticks elapse before the onRejected handlers (attached
    // via .then on the rejected promise) actually fire.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toEqual([
      { id: "c1", status: "rejected" },
      { id: "c2", status: "rejected" }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Multi-turn integration: executor + gate + agent loop + fake transport.
// ---------------------------------------------------------------------------

describe("runAgentLoop + createToolExecutor — multi-turn tool-result", () => {
  it("feeds the approved read-file result back to the model as a tool message", async () => {
    const runtime = fakeRuntime();
    runtime.files.set("README.md", "Fable rocks");
    const gate = createApprovalGate();
    const executor = createToolExecutor({ runtime, gate });

    const seenMessages: { role: string; content: string; toolCallId?: string }[] = [];
    let turn = 0;
    const transport: HttpTransport = {
      async *stream(request) {
        seenMessages.push(
          ...request.messages.map((m) => ({
            role: m.role,
            content: m.content,
            toolCallId: m.toolCallId
          }))
        );
        if (turn === 0) {
          turn += 1;
          yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}';
          yield 'data: {"choices":[{"finish_reason":"tool_calls"}]}';
        } else {
          yield 'data: {"choices":[{"delta":{"content":"done"}}]}';
          yield 'data: {"choices":[{"finish_reason":"stop"}]}';
        }
      }
    };

    const events: { type: string; [k: string]: unknown }[] = [];
    for await (const event of runAgentLoop(
      transport,
      {
        providerId: "openai",
        model: "gpt-5",
        messages: [{ role: "user", content: "read README.md" }],
        tools: [],
        maxTokens: 1024
      },
      { execute: executor }
    )) {
      events.push(event as { type: string; [k: string]: unknown });
      if (event.type === "tool-call") {
        // Register + grant when the tool-call surfaces so the executor unblocks.
        gate.register(event.approval);
        gate.resolveGrant(event.approval.id);
      }
    }

    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].ok).toBe(true);
    expect(toolResults[0].output).toBe("Fable rocks");

    // Turn 2's request carried the tool-role message with the file content.
    const toolMessages = seenMessages.filter((m) => m.role === "tool");
    expect(toolMessages.some((m) => m.content === "Fable rocks")).toBe(true);

    // The loop continued past the tool turn to a done event.
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("continues the loop with a tool-role error when the executor rejects", async () => {
    const runtime = fakeRuntime(); // no "missing.md" -> read returns null -> error
    const gate = createApprovalGate();
    const executor = createToolExecutor({ runtime, gate });

    let turn = 0;
    const transport: HttpTransport = {
      async *stream() {
        if (turn === 0) {
          turn += 1;
          yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-file","arguments":"{\\"path\\":\\"missing.md\\"}"}}]}}]}';
          yield 'data: {"choices":[{"finish_reason":"tool_calls"}]}';
        } else {
          yield 'data: {"choices":[{"delta":{"content":"recovered"}}]}';
          yield 'data: {"choices":[{"finish_reason":"stop"}]}';
        }
      }
    };

    const events: { type: string; [k: string]: unknown }[] = [];
    for await (const event of runAgentLoop(
      transport,
      {
        providerId: "openai",
        model: "gpt-5",
        messages: [{ role: "user", content: "read missing.md" }],
        tools: [],
        maxTokens: 1024
      },
      { execute: executor }
    )) {
      events.push(event as { type: string; [k: string]: unknown });
      if (event.type === "tool-call") {
        gate.register(event.approval);
        gate.resolveGrant(event.approval.id);
      }
    }

    const failed = events.find((e) => e.type === "tool-result" && !e.ok);
    expect(failed).toBeDefined();
    expect(String(failed?.output).toLowerCase()).toMatch(/not found|missing/);
    // The loop still continued to a done event despite the failed tool.
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});
