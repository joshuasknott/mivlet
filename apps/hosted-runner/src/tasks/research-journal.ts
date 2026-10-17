import { HOSTED_PUBLIC_WEB_LIMITS as L, type HostedPublicWebProgress, type HostedPublicWebSource, type HostedPublicWebTaskBinding } from "@mivlet/protocol";

export interface ResearchStep {
  id: string; kind: "model" | "read"; inputSha256: string;
  status: "dispatching" | "completed"; outputSha256?: string;
}
export interface ResearchState extends HostedPublicWebProgress {
  attempt: string; deadline: number; allocatedTokens: number; steps: ResearchStep[];
}
export interface ResearchJournal {
  model(inputSha256: string, tokens: number): Promise<string>;
  read(inputSha256: string): Promise<string>;
  finish(id: string, outputSha256: string, source?: HostedPublicWebSource): Promise<void>;
  progress(): HostedPublicWebProgress;
}
export function researchState(attempt: string, elapsedMs: number): ResearchState {
  return { attempt, deadline: Date.now() + elapsedMs, modelCalls: 0, pageReads: 0, sourceBytes: 0, allocatedTokens: 0, sources: [], steps: [] };
}
/** Update callback performs the durable current-reservation/generation check.
 * Dispatch entries commit before egress. No unfinished step is ever replayed. */
export function researchJournal(binding: HostedPublicWebTaskBinding, change: <T>(operation: (state: ResearchState) => T) => Promise<T>, signal: AbortSignal): ResearchJournal {
  let visible: HostedPublicWebProgress = { modelCalls: 0, pageReads: 0, sourceBytes: 0, sources: [] };
  const update = async <T>(operation: (state: ResearchState) => T): Promise<T> => {
    signal.throwIfAborted();
    const result = await change(state => {
      signal.throwIfAborted(); if (state.deadline <= Date.now()) throw new Error("research-deadline");
      const value = operation(state);
      visible = { modelCalls: state.modelCalls, pageReads: state.pageReads, sourceBytes: state.sourceBytes, sources: structuredClone(state.sources) };
      return value;
    });
    signal.throwIfAborted(); return result;
  };
  const start = (kind: ResearchStep["kind"], inputSha256: string, tokens = 0) => update(state => {
    if (!/^[0-9a-f]{64}$/.test(inputSha256) || state.steps.length >= L.modelCalls + L.pageReads) throw new Error("research-step-limit");
    if (kind === "model") {
      if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > L.tokensPerCall
        || state.modelCalls >= binding.budget.maxModelCalls || state.allocatedTokens + tokens > binding.budget.maxOutputTokens) throw new Error("research-model-limit");
      state.modelCalls++; state.allocatedTokens += tokens;
    } else {
      if (state.pageReads >= binding.budget.maxPageReads || state.sourceBytes >= binding.budget.maxSourceBytes) throw new Error("research-read-limit");
      state.pageReads++;
    }
    const id = `${state.attempt}:${state.steps.length + 1}`;
    state.steps.push({ id, kind, inputSha256, status: "dispatching" }); return id;
  });
  return {
    model: (digest, tokens) => start("model", digest, tokens), read: digest => start("read", digest),
    finish: (id, outputSha256, source) => update(state => {
      const step = state.steps.find(step => step.id === id);
      if (!step || step.status !== "dispatching" || !/^[0-9a-f]{64}$/.test(outputSha256)) throw new Error("research-step-not-current");
      if (source) {
        if (step.kind !== "read" || !Number.isSafeInteger(source.contentBytes) || source.contentBytes < 1 || source.contentBytes > L.pageTextBytes
          || state.sourceBytes + source.contentBytes > binding.budget.maxSourceBytes) throw new Error("research-source-limit");
        state.sourceBytes += source.contentBytes; state.sources.push(source);
      }
      step.status = "completed"; step.outputSha256 = outputSha256;
    }),
    progress: () => structuredClone(visible),
  };
}
