import { Agent } from "agents";
import probeWorker, { CompatibilityProbe } from "./worker";
export { CompatibilityProbe } from "./worker";

interface Env {
  PROBE: DurableObjectNamespace<CompatibilityProbe>;
  TASK: DurableObjectNamespace<FixtureTask>;
}
const artifact = "alpha=2\nbeta=3\ngamma=5\ntotal=10\n";
const owner = { account: "fixture-account", workspace: "fixture-workspace", agent: "fixture-agent" };
interface Approval {
  id: string; task: string; attempt: string; generation: number;
  owner: typeof owner; tool: "write_summary"; argsHash: string; artifactHash: string; expires: number;
}
interface TaskState {
  status: "idle" | "scheduled" | "running" | "approval" | "completed" | "cancelled" | "blocked";
  task?: string; attempt?: string; generation: number; scheduleId?: string;
  approval?: Approval; artifact?: string;
  receipt?: { id: string; attempt: string; generation: number; artifactHash: string; bytes: number };
  reason?: string;
}
async function hash(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Bounded local workerd acceptance task. No user context or credentials admitted.
 * Agents owns schedules/state here; OpenCode owns an entirely different DO.
 * The only effect is writing the fixed artifact and its receipt in one state row.
 */
export class FixtureTask extends Agent<Env, TaskState> {
  initialState: TaskState = { status: "idle", generation: 0 };
  inspect() { return this.state; }

  async begin(task: string) {
    if (this.state.status !== "idle") return this.state;
    const attempt = crypto.randomUUID();
    this.setState({ status: "scheduled", task, attempt, generation: 1 });
    const scheduled = await this.schedule(1, "prepare", { attempt, generation: 1 }, { idempotent: true });
    if (this.inspect().status === "scheduled") this.setState({ ...this.state, scheduleId: scheduled.id });
    return this.state;
  }

  async prepare(binding: { attempt: string; generation: number }) {
    if (this.state.attempt !== binding.attempt || this.state.generation !== binding.generation || this.state.status !== "scheduled") return;
    this.setState({ ...this.state, status: "running" });
    try {
      const result = await this.env.PROBE.getByName(`task-${binding.attempt}`).run();
      if (this.state.generation !== binding.generation || this.inspect().status !== "running") return;
      if (result.modelCalls !== 2 || result.toolCalls !== 1 || result.outcome !== "completed") {
        this.setState({ ...this.state, status: "blocked", reason: "The pinned OpenCode workerd model/tool acceptance gate failed." });
        return;
      }
      const approval: Approval = {
        id: crypto.randomUUID(), task: this.state.task!, attempt: binding.attempt, generation: binding.generation,
        owner, tool: "write_summary", argsHash: await hash('{"dataset":"fixture-v1"}'), artifactHash: await hash(artifact), expires: Date.now() + 15 * 60_000,
      };
      if (this.state.generation !== binding.generation || this.inspect().status !== "running") return;
      this.setState({ ...this.state, status: "approval", approval });
    } catch {
      if (this.state.generation === binding.generation && this.inspect().status === "running") this.setState({ ...this.state, status: "blocked", reason: "The fixture model attempt failed; no effect was committed." });
    }
  }

  // Explicit recovery never replays an SDK session that may have had an effect.
  // This fixture attempt has no external effects, but still requires a new start
  // after a process restart during model execution.
  async resume() {
    if (this.state.status === "scheduled") await this.prepare({ attempt: this.state.attempt!, generation: this.state.generation });
    else if (this.state.status === "running") {
      await this.cancel();
      this.setState({ ...this.state, status: "blocked", reason: "The prior attempt was interrupted. Start a new task with a fresh approval." });
    }
    return this.state;
  }

  approve(submitted: Approval) {
    const pending = this.state.approval;
    if (this.state.status !== "approval" || !pending || Date.now() > pending.expires
      || !submitted || Object.keys(submitted).sort().join() !== Object.keys(pending).sort().join()
      || Object.keys(pending).some(key => JSON.stringify(submitted[key as keyof Approval]) !== JSON.stringify(pending[key as keyof Approval]))) {
      throw new Error("The approval is stale, mismatched or already consumed.");
    }
    // No await: the exact approval and artifact are committed atomically by the
    // Agents SDK's durable state write. Retries inspect the receipt, never rerun.
    this.setState({ ...this.state, status: "completed", approval: undefined, artifact,
      receipt: { id: crypto.randomUUID(), attempt: pending.attempt, generation: pending.generation,
        artifactHash: pending.artifactHash, bytes: new TextEncoder().encode(artifact).length } });
    return this.state;
  }

  async cancel() {
    if (["completed", "cancelled"].includes(this.state.status)) return this.state;
    const previous = this.state;
    this.setState({ ...previous, status: "cancelled", generation: previous.generation + 1, approval: undefined });
    if (previous.scheduleId) await this.cancelSchedule(previous.scheduleId);
    if (previous.attempt) await this.env.PROBE.getByName(`task-${previous.attempt}`).cancel();
    return this.state;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/task/")) return probeWorker.fetch(request, env);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || request.headers.has("origin") || request.headers.has("sec-fetch-site")) return new Response("Local CLI fixture only", { status: 403 });
    const match = /^\/task\/([a-zA-Z0-9_-]{1,64})\/(start|status|resume|approve|cancel)$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const [, id, action] = match;
    if (request.method !== (action === "status" ? "GET" : "POST")) return new Response("Method not allowed", { status: 405 });
    let body = "";
    if (request.body) {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength + body.length > 2048 || action !== "approve") {
          await reader.cancel();
          return new Response("Only the exact fixture approval is accepted", { status: 400 });
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
    }
    const task = env.TASK.getByName(id);
    try {
      const state = action === "status" ? await task.inspect() : action === "start" ? await task.begin(id)
        : action === "resume" ? await task.resume() : action === "cancel" ? await task.cancel()
        : await task.approve(JSON.parse(body) as Approval);
      return Response.json(state);
    } catch { return new Response("The task request is invalid or no longer current", { status: 409 }); }
  },
};
