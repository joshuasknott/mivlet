import { OpenCode, type OpenCodeEvent } from "@opencode/sdk";
import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { AgentTurnRequest, BackendAgentEvent } from "@fable/protocol";

export interface HostInput {
  request: AgentTurnRequest;
  providerId: string;
  contextPrefix?: string;
  maxTurns: number;
  maxToolCalls: number;
  contextWindow?: number;
}

export interface HostBoundary {
  directory: string;
  signal: AbortSignal;
  model(body: unknown): Promise<Response>;
  tool(callId: string, tool: string, args: string): Promise<{ ok: boolean; output: string }>;
  event(event: BackendAgentEvent): void;
}

/** One ephemeral SDK session per Mivlet attempt. Mivlet keeps all durable state. */
export async function runHost(input: HostInput, boundary: HostBoundary): Promise<void> {
  const { request } = input;
  const check = () => boundary.signal.throwIfAborted();
  check();
  let modelCalls = 0;
  let toolCalls = 0;
  let sessionId = "";
  let finish: "stop" | "length" = "stop";
  const seen = new Set<string>();
  const observed = new Set<string>();
  const barriers = new Map<string, () => void>();
  const token = crypto.randomUUID();
  // The SDK's native provider talks only to this owned, authenticated bridge.
  // The bridge has no provider key; Rust owns the remote socket and credential.
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(http) {
      if (http.method !== "POST" || http.headers.get("authorization") !== `Bearer ${token}`
        && http.headers.get("x-api-key") !== token) return new Response(null, { status: 403 });
      try {
        check();
        if (++modelCalls > input.maxTurns) throw new Error("Model step limit reached.");
        const raw = await http.text();
        if (raw.length > 2 * 1024 * 1024) throw new Error("Model request too large.");
        const body: unknown = JSON.parse(raw);
        return await boundary.model(body);
      } catch {
        return Response.json({ error: { message: "Mivlet provider boundary refused this request." } }, { status: 502 });
      }
    },
  });
  const policy = [{ action: "*", resource: "*", effect: "deny" as const },
    ...request.tools.map(tool => ({ action: tool.name, resource: "*", effect: "allow" as const }))];
  const plugin = Plugin.define({ id: "mivlet-authority", async setup(ctx) {
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) editor.remove(tool.id);
      for (const tool of request.tools) editor.add({
        name: tool.name, description: tool.description, input: JSON.parse(tool.parameters),
        options: { codemode: false, permission: tool.name },
        async execute(args, context) {
          check();
          const callId = String(context.id);
          const encoded = JSON.stringify(args);
          if (!/^[a-zA-Z0-9_-]{1,160}$/.test(callId) || seen.has(callId)
            || ++toolCalls > input.maxToolCalls || encoded.length > 64_000) throw new Error("Invalid or replayed tool call.");
          seen.add(callId);
          // Preserve text/tool ordering even when event delivery trails execution.
          if (!observed.has(callId)) await new Promise<void>(resolve => barriers.set(callId, resolve));
          check();
          const result = await boundary.tool(callId, tool.name, encoded);
          check();
          if (result.output.length > 64_000) throw new Error("Tool output limit exceeded.");
          if (!result.ok) throw new ToolError({ message: result.output });
          return { content: result.output };
        },
      });
    });
    await ctx.agent.transform(editor => {
      for (const agent of editor.list()) if (String(agent.id) !== "build") editor.remove(String(agent.id));
      editor.update("build", agent => { agent.permissions = policy; });
    });
    await ctx.session.hook("title", event => { event.result = "Mivlet conversation"; });
    await ctx.session.hook("retry", event => { event.decision = { retry: false }; });
    await ctx.shell.hook("create.before", () => { throw new Error("Host shell is unavailable."); });
    await ctx.session.hook("context", event => {
      check();
      event.system = [{ type: "text", text: input.contextPrefix ?? "You are a Mivlet agent. Use only the supplied Mivlet tools." }];
      // Prior Mivlet history is context, never imported into an SDK disk format.
      const history: SessionContext["messages"] = request.messages.filter(m => m.role !== "system").map(message => ({
        role: message.role,
        content: message.role === "tool" ? [{ type: "tool-result", id: message.toolCallId ?? "", name: message.toolName ?? "", result: { type: "text", value: message.content } }]
          : [{ type: "text", text: message.content }, ...(message.toolCalls ?? []).map(call => ({ type: "tool-call" as const, id: call.callId, name: call.tool, input: JSON.parse(call.arguments) }))],
      }));
      event.system.push(...request.messages.filter(m => m.role === "system").map(m => ({ type: "text" as const, text: m.content })));
      event.messages = [...history, ...event.messages.slice(1)];
      event.options.maxTokens = request.maxTokens;
      if (request.reasoningEffort) event.options.reasoningEffort = request.reasoningEffort;
    });
  } });
  const host = await OpenCode.create({
    database: { path: ":memory:" }, events: { persist: false },
    models: { snapshot: false, fetch: false }, fs: { filewatcher: false, fff: false },
    config: { directory: boundary.directory, project: false, content: JSON.stringify({
      model: `mivlet/${request.model}`, default_agent: "build", share: "disabled", update: "disable",
      snapshots: false, compaction: { auto: false }, tool_output: { max_bytes: 1_048_576, max_lines: 100_000 },
      mcp: { servers: {} }, plugins: [], instructions: [], skills: [], commands: {},
      providers: { mivlet: { package: input.providerId === "anthropic" ? "@opencode/ai/providers/anthropic" : "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: token }, models: {
          [request.model]: { name: request.model, capabilities: { tools: request.tools.length > 0, input: ["text"], output: ["text"] }, limit: { context: input.contextWindow ?? 128_000, output: request.maxTokens } },
        } } }, agents: { build: { steps: input.maxTurns, permissions: policy } }, permissions: policy,
    }) },
    plugins: [plugin], log: { level: "error", emit: () => {} },
  });
  const events = new AbortController();
  const cancel = () => {
    for (const resolve of barriers.values()) resolve();
    barriers.clear();
    if (sessionId) void host.sessions.interrupt({ sessionID: sessionId, continue: false }).catch(() => {});
    events.abort();
  };
  boundary.signal.addEventListener("abort", cancel, { once: true });
  try {
    check();
    const session = await host.sessions.create({ location: { directory: boundary.directory }, title: "Mivlet conversation" });
    sessionId = session.id;
    const stream = (async () => {
      for await (const event of host.events.subscribe({ signal: events.signal })) {
        if (!hasSession(event, sessionId)) continue;
        check();
        const data = event.data as Record<string, unknown>;
        if (event.type === "session.text.delta" && typeof data.delta === "string") boundary.event({ type: "text-delta", text: data.delta });
        if (event.type === "session.tool.called" && typeof data.id === "string") {
          observed.add(data.id); barriers.get(data.id)?.(); barriers.delete(data.id);
        }
        if (event.type === "session.step.ended") {
          if (data.finish === "length") finish = "length";
          const tokens = data.tokens as { input: number; output: number };
          boundary.event({ type: "usage", inputTokens: tokens.input, outputTokens: tokens.output, costUsd: 0, costUnknown: true });
        }
        if (event.type === "session.execution.succeeded") return;
        if (event.type === "session.execution.failed") throw new Error("OpenCode could not complete this provider turn.");
      }
      check();
      throw new Error("OpenCode event stream ended before completion.");
    })();
    // Observe stream failures immediately even if prompt admission is still pending.
    void stream.catch(() => {});
    await host.sessions.prompt({ sessionID: sessionId, text: "Continue the supplied Mivlet conversation.", resume: true });
    await stream;
    check();
    boundary.event({ type: "done", finishReason: finish });
  } finally {
    events.abort(); boundary.signal.removeEventListener("abort", cancel);
    for (const resolve of barriers.values()) resolve();
    await host.close(); server.stop(true);
  }
}

function hasSession(event: OpenCodeEvent, id: string) {
  return "sessionID" in event.data && event.data.sessionID === id;
}
