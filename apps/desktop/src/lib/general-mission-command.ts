const MAX_TASKS = 6;
const MAX_TITLE_LENGTH = 160;
const MAX_TASK_LENGTH = 1_000;

export interface GeneralMissionDraft {
  title: string;
  tasks: string[];
}

/**
 * Parse the calm multiline `/mission` contract.
 *
 * The first line names the work. Every following non-empty line must be a
 * bullet or numbered task. Tasks are deliberately independent: Fable does not
 * imply output handoff or synthesis authority that the selected Plan did not
 * declare.
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
  const tasks = lines.slice(1).map((line) => {
    const match = /^(?:[-*]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    return match?.[1]?.trim() ?? "";
  });
  if (
    tasks.length < 2
    || tasks.length > MAX_TASKS
    || tasks.some((task) => !task || task.length > MAX_TASK_LENGTH)
    || new Set(tasks.map((task) => task.toLocaleLowerCase())).size !== tasks.length
  ) {
    return null;
  }
  return { title, tasks };
}
