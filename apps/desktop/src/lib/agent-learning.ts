import type { FableAgentProfile, FableLearnedTask } from "@fable/protocol";

export const MAX_LEARNED_TASKS = 24;

const teammateNameRules: Array<[RegExp, string]> = [
  [/\b(research|brief|analyse|analyze)\b/i, "Research Partner"],
  [/\b(daily|priorit(?:y|ies)|calendar|inbox|organis|organiz)\b/i, "Daily Coordinator"],
  [/\b(sales|outbound|lead|prospect)\b/i, "Sales Partner"],
  [/\b(project|roadmap|delivery)\b/i, "Delivery Lead"],
  [/\b(code|coding|software|developer|engineering|build the app)\b/i, "Developer"],
  [/\b(write|writing|content|newsletter|social|draft)\b/i, "Content Partner"],
  [/\b(finance|financial|expense|budget|invoice)\b/i, "Finance Partner"],
  [/\b(hiring|talent|recruit|candidate)\b/i, "Talent Partner"]
];

const teammateNameStopWords = new Set([
  "a", "an", "and", "around", "be", "for", "help", "i", "keep", "me", "my", "of", "on",
  "manage", "our", "own", "please", "prepare", "repeat", "specific", "the", "this", "to", "up",
  "want", "with", "you"
]);

function compact(value: string, limit: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function suggestTeammateName(brief: string): string {
  const clean = compact(brief.replace(/^\/[a-z-]+\s+/i, ""), 500);
  const matched = teammateNameRules.find(([pattern]) => pattern.test(clean));
  if (matched) return matched[1];
  const words = clean
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)
    ?.filter((word) => !teammateNameStopWords.has(word.toLocaleLowerCase()))
    .slice(0, 3) ?? [];
  const title = words
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1).toLocaleLowerCase()}`)
    .join(" ")
    .slice(0, 48);
  return title || "New agent";
}

export function suggestedLearnedTask(prompt: string): Pick<FableLearnedTask, "title" | "instruction"> {
  const instruction = prompt.trim().slice(0, 4_000);
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? "";
  const title = compact(firstLine.replace(/^#+\s*/, ""), 72) || "Repeat this work";
  return { title, instruction };
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
