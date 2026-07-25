const MAX_TASKS = 6;
const MAX_TITLE_LENGTH = 160;
const MAX_TASK_LENGTH = 1_000;
const MAX_ACCEPTANCE_CRITERIA = 4;
const MAX_ACCEPTANCE_CRITERION_LENGTH = 500;

export interface GeneralMissionDraft {
  title: string;
  tasks: string[];
  acceptanceCriteria?: string[];
  graph?: {
    steps: Array<{
      strategy: "all" | "any";
      dependsOn: number[];
      task: string;
    }>;
  };
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
 * one revision pass. Final `accept:` lines can declare up to four exact
 * human-evaluated acceptance criteria. For a bounded non-linear graph, repeated
 * `all 1,2: ...` or `any 2,3: ...` lines can instead name exact earlier step
 * numbers. No dependency, synthesis, or acceptance authority is inferred from
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
  type Declaration = {
    kind: "all" | "any" | "then" | "review" | "revise" | "accept";
    dependencies: number[] | null;
    task: string;
  };
  const parseDeclaration = (line: string): Declaration | null => {
    const match = /^(all|any|then|review|revise|accept)(?:\s+(\d{1,2}(?:\s*,\s*\d{1,2})+))?:\s+(.+)$/i.exec(
      line
    );
    if (!match) return null;
    const dependencies = match[2]
      ? match[2].split(",").map((value) => Number.parseInt(value.trim(), 10))
      : null;
    return {
      kind: match[1]!.toLocaleLowerCase() as Declaration["kind"],
      dependencies,
      task: match[3]?.trim() ?? ""
    };
  };
  const declarationLines: Declaration[] = [];
  let taskBoundary = lines.length;
  while (taskBoundary > 1) {
    const declared = parseDeclaration(lines[taskBoundary - 1] ?? "");
    if (!declared) break;
    declarationLines.unshift(declared);
    taskBoundary -= 1;
  }
  const declarationKinds = declarationLines.map((line) => line.kind);
  const acceptanceIndex = declarationKinds.indexOf("accept");
  const validAcceptanceSuffix =
    acceptanceIndex === -1
    || declarationKinds.slice(acceptanceIndex).every((kind) => kind === "accept");
  const continuationLines = declarationLines.slice(
    0,
    acceptanceIndex === -1 ? declarationLines.length : acceptanceIndex
  );
  const acceptanceLines = acceptanceIndex === -1
    ? []
    : declarationLines.slice(acceptanceIndex);
  const explicitGraph = continuationLines.some(
    (line) => line.dependencies !== null
  );
  const firstContinuation = continuationLines[0];
  const continuationKinds = continuationLines.map((line) => line.kind);
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
      !explicitGraph
      && firstContinuation !== undefined
      && /^(all|any)$/i.test(firstContinuation.kind)
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
  const continuationTasks = continuationLines.map((line) => line.task);
  const acceptanceCriteria = acceptanceLines.map((line) => line.task);
  const allObjectives = [...tasks, ...continuationTasks];
  const graphSteps = explicitGraph
    ? continuationLines.map((line, index) => {
        const dependencies = line.dependencies ?? [];
        const availableSteps = tasks.length + index;
        const uniqueDependencies = new Set(dependencies);
        if (
          (line.kind !== "all" && line.kind !== "any")
          || dependencies.length < 2
          || uniqueDependencies.size !== dependencies.length
          || dependencies.some((dependency) =>
            !Number.isInteger(dependency)
            || dependency < 1
            || dependency > availableSteps
          )
        ) {
          return null;
        }
        return {
          strategy: line.kind,
          dependsOn: dependencies,
          task: line.task
        };
      })
    : [];
  if (
    !validAcceptanceSuffix
    || acceptanceLines.some((line) => line.dependencies !== null)
    || (explicitGraph
      ? graphSteps.some((step) => step === null)
        || continuationLines.some((line) => line.dependencies === null)
      : !validContinuationChain)
    || tasks.length < 2
    || allObjectives.length > MAX_TASKS
    || tasks.some((task) => !task || task.length > MAX_TASK_LENGTH)
    || continuationTasks.some((task) => !task || task.length > MAX_TASK_LENGTH)
    || new Set(allObjectives.map((task) => task.toLocaleLowerCase())).size !== allObjectives.length
    || acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA
    || acceptanceCriteria.some(
      (criterion) => !criterion || criterion.length > MAX_ACCEPTANCE_CRITERION_LENGTH
    )
    || new Set(acceptanceCriteria.map((criterion) => criterion.toLocaleLowerCase())).size
      !== acceptanceCriteria.length
  ) {
    return null;
  }
  return {
    title,
    tasks,
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(explicitGraph
      ? {
          graph: {
            steps: graphSteps as NonNullable<GeneralMissionDraft["graph"]>["steps"]
          }
        }
      : {}),
    ...(firstContinuation
      && !explicitGraph
      ? {
          join: {
            strategy: firstContinuation.kind as "all" | "any",
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
