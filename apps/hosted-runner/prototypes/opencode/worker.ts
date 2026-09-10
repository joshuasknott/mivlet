import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { fixtureChatResponse, makeFixtureBaseURL, syntheticPlugin } from "./synthetic-model";

interface Env { PROBE: DurableObjectNamespace<CompatibilityProbe> }
interface Evidence {
  boots: number;
  pluginSetups: number;
  modelCalls: number;
  toolCalls: number;
  sessionId?: string;
  outcome?: string;
  error?: string;
  timedOut?: boolean;
}

type FixtureFetch = typeof globalThis.fetch;
const fixtures = new Map<string, { evidence: Evidence; active: () => boolean; deadline: () => number }>();
// Fixture transport only. Unknown endpoints fail closed rather than reaching a
// real provider. Registration is bounded to currently running probe attempts.
const fixtureFetch: FixtureFetch = async (input, init) => {
  const request = new Request(input, init);
  const fixture = fixtures.get(request.url);
  if (!fixture || request.method !== "POST") throw new Error("External network is unavailable in the local fixture.");
  if (!fixture.active() || Date.now() > fixture.deadline() || ++fixture.evidence.modelCalls > 3) throw new Error("Mivlet probe budget or recovery fence");
  return fixtureChatResponse(request);
};
globalThis.fetch = fixtureFetch;

function installFixtureFetch(baseURL: string, evidence: Evidence, active: () => boolean, deadline: () => number) {
  const endpoint = `${baseURL.replace(/\/$/, "")}/chat/completions`;
  fixtures.set(endpoint, { evidence, active, deadline });
  return () => fixtures.delete(endpoint);
}

// A compatibility reproducer, not a production task API. It accepts no prompts,
// identity, provider configuration or credentials. The only context is synthetic.
export class CompatibilityProbe extends DurableObject<Env> {
  private readonly fixtureBaseURL = makeFixtureBaseURL(crypto.randomUUID());
  private readonly host: Promise<OpenCodeWorkerd.Interface>;
  private readonly evidence: Evidence;
  private active = false;
  private cancelled = false;
  private deadline = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.evidence = { boots: 0, pluginSetups: 0, modelCalls: 0, toolCalls: 0 };
    this.host = state.blockConcurrencyWhile(async () => {
      const host = await OpenCodeWorkerd.create({
      storage: state.storage,
      models: { snapshot: false, fetch: false },
      plugins: [syntheticPlugin(
        () => { this.evidence.pluginSetups++; },
        () => {
          if (!this.active || Date.now() > this.deadline) throw new Error("Mivlet probe stopped");
          if (++this.evidence.toolCalls > 1) throw new Error("The fixture tool was already proposed.");
          // No write is authorized by this compatibility probe.
          return "paused: Mivlet approval required for fixture-v1 summary";
        },
      )],
      log: { level: "error", emit: () => {
        // Never retain arbitrary SDK diagnostics, prompt bodies or stack traces.
        this.evidence.error = "SDK session failed; inspect locally with synthetic data only";
      } },
      config: {
        share: "disabled", update: "disable", snapshots: false, compaction: { auto: false }, model: "synthetic/summary",
        providers: { synthetic: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: this.fixtureBaseURL, apiKey: "fixture-only" }, models: {
          summary: { name: "Synthetic fixture", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 8192, output: 256 } },
        } } },
        agents: { build: { steps: 3 } },
        permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "write_summary", resource: "*", effect: "allow" }],
      },
      });
      // SDK migration expects an empty database on first boot. This diagnostic
      // marker is written afterwards; production authority needs a separate DO.
      this.evidence.boots = ((await state.storage.get<number>("mivlet-probe-boots")) ?? 0) + 1;
      await state.storage.put("mivlet-probe-boots", this.evidence.boots);
      return host;
    });
  }

  async inspect(): Promise<Evidence & { persistedSessionId: string | null; sdkSessionPersisted: boolean }> {
    const host = await this.host;
    const persistedSessionId = (await this.ctx.storage.get<string>("mivlet-last-session")) ?? null;
    const sdkSessionPersisted = persistedSessionId !== null && (await host.sessions.get({ sessionID: persistedSessionId })).id === persistedSessionId;
    return { ...this.evidence, persistedSessionId, sdkSessionPersisted };
  }

  async run(): Promise<Evidence> {
    const host = await this.host;
    if (this.cancelled) return { ...this.evidence, outcome: "cancelled" };
    // At most one attempt per boot. Restarting preserves the previous session ID,
    // but does not authorize replay or a real provider request.
    if (this.active || this.evidence.sessionId) return { ...this.evidence };
    this.active = true;
    this.deadline = Date.now() + 15_000;
    const releaseFixture = installFixtureFetch(this.fixtureBaseURL, this.evidence, () => this.active, () => this.deadline);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const session = await host.sessions.create({ title: "Mivlet synthetic compatibility probe" });
    this.evidence.sessionId = session.id;
    await this.ctx.storage.put("mivlet-last-session", session.id);
    try {
      await Promise.race([
        (async () => {
          await host.sessions.prompt({ sessionID: session.id, text: "Call write_summary for fixture-v1.", resume: true });
          await host.sessions.wait({ sessionID: session.id });
          const outcome = (await host.sessions.get({ sessionID: session.id })).outcome;
          // OpenCode calls a completed execution "succeeded"; the enclosing
          // task authority uses its stable "completed" state.
          this.evidence.outcome = outcome === "succeeded" ? "completed" : outcome;
        })(),
        new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error("Probe timeout")), 15_000); }),
      ]);
    } catch {
      this.evidence.timedOut = Date.now() >= this.deadline;
      this.evidence.outcome = "failed";
    } finally {
      this.active = false;
      releaseFixture();
      if (timeout !== undefined) clearTimeout(timeout);
      // The durable/active fence is effective before this best-effort interruption.
      void host.sessions.interrupt({ sessionID: session.id, continue: false }).catch(() => {});
    }
    return { ...this.evidence };
  }

  async cancel(): Promise<Evidence> {
    this.cancelled = true;
    this.active = false;
    this.deadline = 0;
    if (this.evidence.sessionId) {
      const host = await this.host;
      void host.sessions.interrupt({ sessionID: this.evidence.sessionId, continue: false }).catch(() => {});
    }
    return { ...this.evidence };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response("Local compatibility probe only", { status: 403 });
    // Browser pages cannot use this loopback test API via cross-origin requests.
    if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return new Response("CLI only", { status: 403 });
    if (request.body !== null) {
      const reader = request.body.getReader();
      const chunk = await reader.read();
      await reader.cancel();
      if (!chunk.done && chunk.value.length > 0) return new Response("No input accepted", { status: 400 });
    }
    const probe = env.PROBE.getByName("synthetic-compatibility-probe-v2");
    if (request.method === "GET" && url.pathname === "/status") return Response.json(await probe.inspect());
    if (request.method === "GET" && url.pathname === "/probe-status") {
      const name = url.searchParams.get("name");
      if (!name || !/^[a-zA-Z0-9_-]{1,160}$/.test(name)) return new Response("Invalid probe name", { status: 400 });
      return Response.json(await env.PROBE.getByName(name).inspect());
    }
    if (request.method === "POST" && url.pathname === "/cancel") return Response.json(await probe.cancel());
    if (request.method === "POST" && url.pathname === "/run") {
      const result = await probe.run();
      return Response.json(result, { status: result.toolCalls > 0 ? 200 : 422 });
    }
    return new Response("Not found", { status: 404 });
  },
};
