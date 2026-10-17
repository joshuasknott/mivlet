import { HOSTED_CODING_LIMITS as L, type HostedCodingTaskBinding, type HostedCodingProgress } from "@mivlet/protocol";

export interface CodingStep { id: string; kind: "model" | "read" | "write" | "check"; inputSha256: string; status: "dispatching" | "completed"; outputSha256?: string }
export interface CodingState {
  deadline: number; modelCalls: number; toolCalls: number; allocatedOutputTokens: number;
  steps: CodingStep[]; completedChecks: HostedCodingProgress["completedChecks"];
}
export interface CodingJournal {
  start(kind: CodingStep["kind"], inputSha256: string, tokens?: number): Promise<string>;
  finish(id: string, outputSha256: string, check?: HostedCodingProgress["completedChecks"][number]): Promise<void>;
  progress(): Promise<CodingState>;
}
export function codingState(elapsed: number): CodingState { return { deadline: Date.now() + elapsed, modelCalls: 0, toolCalls: 0, allocatedOutputTokens: 0, steps: [], completedChecks: [] }; }
/** Same task generation/attempt is checked in the owning durable transaction.
 * An unfinished model/check step is evidence of uncertainty, never replay. */
export function codingJournal(binding: HostedCodingTaskBinding, change: <T>(operation: (state: CodingState) => T) => Promise<T>): CodingJournal {
  return {
    start: (kind, inputSha256, tokens = 0) => change(state => {
      if (state.deadline <= Date.now() || !/^[a-f0-9]{64}$/.test(inputSha256) || state.steps.length >= L.modelCalls + L.toolCalls
        || state.steps.some(step => step.status === "dispatching")) throw new Error("coding-step-not-current");
      if (kind === "model") {
        if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > L.tokensPerCall || state.modelCalls >= binding.budget.maxModelCalls
          || state.allocatedOutputTokens + tokens > binding.budget.maxOutputTokens) throw new Error("coding-model-limit");
        state.modelCalls++; state.allocatedOutputTokens += tokens;
      } else { if (state.toolCalls >= binding.budget.maxToolCalls) throw new Error("coding-tool-limit"); state.toolCalls++; }
      const id = crypto.randomUUID(); state.steps.push({ id, kind, inputSha256, status: "dispatching" }); return id;
    }),
    finish: (id, outputSha256, check) => change(state => {
      if (state.deadline <= Date.now() || !/^[a-f0-9]{64}$/.test(outputSha256)) throw new Error("coding-step-not-current");
      const step = state.steps.find(step => step.id === id);
      if (!step || step.status !== "dispatching") throw new Error("coding-step-not-current");
      if (check) { if (step.kind !== "check") throw new Error("coding-step-not-current"); state.completedChecks.push(check); }
      step.status = "completed"; step.outputSha256 = outputSha256;
    }),
    progress: () => change(state => structuredClone(state)),
  };
}
