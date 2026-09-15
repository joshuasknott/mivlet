import type { FableAgentProfile, FableLearnedTask } from "@fable/protocol";

const MAX_LEARNED_TASKS = 24;

function compact(value: string, limit: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function upsertLearnedTask(
  current: readonly FableLearnedTask[],
  task: FableLearnedTask
): FableLearnedTask[] {
  const normalized = {
    ...task,
    title: compact(task.title, 120),
    instruction: task.instruction.trim().slice(0, 4_000)
  };
  if (!normalized.id || !normalized.title || !normalized.instruction) return [...current];
  const existingIndex = current.findIndex((candidate) => candidate.id === normalized.id);
  if (existingIndex >= 0) {
    return current.map((candidate, index) => index === existingIndex ? normalized : candidate);
  }
  return [...current.slice(-(MAX_LEARNED_TASKS - 1)), normalized];
}

export function agentExecutionInstructions(agent: FableAgentProfile): string {
  const base = agent.instructions.trim();
  const learned = (agent.learnedTasks ?? [])
    .filter((task) => task.title.trim() && task.instruction.trim())
    .slice(-MAX_LEARNED_TASKS)
    .map((task) => `- ${compact(task.title, 120)}: ${task.instruction.trim().slice(0, 4_000)}`);
  if (!learned.length) return base;
  return [
    base,
    "Learned responsibilities (explicitly taught by the user):",
    ...learned
  ].filter(Boolean).join("\n\n");
}
