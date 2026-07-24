const MAX_TASKS = 6;
const MAX_TITLE_LENGTH = 160;
const MAX_TASK_LENGTH = 1_000;

export interface GeneralMissionDraft {
  title: string;
  tasks: string[];
  join?: {
    strategy: "all" | "any";
    task: string;
  };
}

/**
 * Parse the calm multiline `/mission` contract.
 *
 * The first line names the work. Every following non-empty line must be a
 * bullet or numbered task. An optional final `all:` or `any:` line explicitly
 * declares one bounded continuation that receives the immutable task outputs.
 * No dependency or synthesis authority is inferred from ordinary bullets.
 */
export function parseGeneralMissionDraft(value: string): GeneralMissionDraft | null {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;
  const title = lines[0]!;
  if (!title || title.length > MAX_TITLE_LENGTH) return null;
  const declaredJoin = /^(all|any):\s+(.+)$/i.exec(lines.at(-1) ?? "");
  const taskLines = lines.slice(1, declaredJoin ? -1 : undefined);
  const tasks = taskLines.map((line) => {
    const match = /^(?:[-*]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    return match?.[1]?.trim() ?? "";
  });
  const joinTask = declaredJoin?.[2]?.trim();
  if (
    tasks.length < 2
    || tasks.length + (declaredJoin ? 1 : 0) > MAX_TASKS
    || tasks.some((task) => !task || task.length > MAX_TASK_LENGTH)
    || (declaredJoin && (!joinTask || joinTask.length > MAX_TASK_LENGTH))
    || new Set(tasks.map((task) => task.toLocaleLowerCase())).size !== tasks.length
    || (joinTask && tasks.some((task) => task.toLocaleLowerCase() === joinTask.toLocaleLowerCase()))
  ) {
    return null;
  }
  return {
    title,
    tasks,
    ...(declaredJoin && joinTask
      ? {
          join: {
            strategy: declaredJoin[1]!.toLocaleLowerCase() as "all" | "any",
            task: joinTask
          }
        }
      : {})
  };
}
