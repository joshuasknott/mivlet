const MAX_TASKS = 6;
const MAX_TITLE_LENGTH = 160;
const MAX_TASK_LENGTH = 1_000;

export interface GeneralMissionDraft {
  title: string;
  tasks: string[];
  join?: {
    strategy: "all" | "any";
    task: string;
    then?: string[];
    review?: {
      task: string;
      revise: string;
    };
  };
}

/**
 * Parse the calm multiline `/mission` contract.
 *
 * The first line names the work. Every following non-empty line must be a
 * bullet or numbered task. An optional `all:` or `any:` line explicitly
 * declares one bounded continuation that receives the immutable task outputs.
 * Following `then:` lines may declare a short sequential chain. An optional
 * final `review:` plus `revise:` pair declares exactly one advisory review and
 * one revision pass. No dependency or synthesis authority is inferred from
 * ordinary bullets.
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
  const continuationLines: RegExpExecArray[] = [];
  let taskBoundary = lines.length;
  while (taskBoundary > 1) {
    const declared = /^(all|any|then|review|revise):\s+(.+)$/i.exec(
      lines[taskBoundary - 1] ?? ""
    );
    if (!declared) break;
    continuationLines.unshift(declared);
    taskBoundary -= 1;
  }
  const firstContinuation = continuationLines[0];
  const continuationKinds = continuationLines.map(
    (line) => line[1]!.toLocaleLowerCase()
  );
  const reviewIndex = continuationKinds.indexOf("review");
  const validReviewPair =
    reviewIndex === -1
    || (
      reviewIndex >= 1
      && reviewIndex === continuationKinds.length - 2
      && continuationKinds[reviewIndex + 1] === "revise"
    );
  const sequentialEnd = reviewIndex === -1 ? continuationKinds.length : reviewIndex;
  const validContinuationChain =
    continuationLines.length === 0
    || (
      firstContinuation !== undefined
      && /^(all|any)$/i.test(firstContinuation[1] ?? "")
      && continuationKinds.slice(1, sequentialEnd).every((kind) => kind === "then")
      && validReviewPair
      && continuationKinds.filter((kind) => kind === "review").length <= 1
      && continuationKinds.filter((kind) => kind === "revise").length <= 1
    );
  const taskLines = lines.slice(1, taskBoundary);
  const tasks = taskLines.map((line) => {
    const match = /^(?:[-*]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    return match?.[1]?.trim() ?? "";
  });
  const continuationTasks = continuationLines.map((line) => line[2]?.trim() ?? "");
  const allObjectives = [...tasks, ...continuationTasks];
  if (
    !validContinuationChain
    || tasks.length < 2
    || allObjectives.length > MAX_TASKS
    || tasks.some((task) => !task || task.length > MAX_TASK_LENGTH)
    || continuationTasks.some((task) => !task || task.length > MAX_TASK_LENGTH)
    || new Set(allObjectives.map((task) => task.toLocaleLowerCase())).size !== allObjectives.length
  ) {
    return null;
  }
  return {
    title,
    tasks,
    ...(firstContinuation
      ? {
          join: {
            strategy: firstContinuation[1]!.toLocaleLowerCase() as "all" | "any",
            task: continuationTasks[0]!,
            ...(sequentialEnd > 1
              ? { then: continuationTasks.slice(1, sequentialEnd) }
              : {}),
            ...(reviewIndex >= 0
              ? {
                  review: {
                    task: continuationTasks[reviewIndex]!,
                    revise: continuationTasks[reviewIndex + 1]!
                  }
                }
              : {})
          }
        }
      : {})
  };
}
