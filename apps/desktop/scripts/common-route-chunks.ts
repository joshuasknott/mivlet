type GetModuleInfo = (id: string) => {
  isEntry: boolean;
  importers: readonly string[];
  dynamicImporters: readonly string[];
} | null;

/** Related deferred views share compression/requests. Every cohort stays in
 * common accounting; separately budgeted conversation engines stay separate. */
export function commonRouteChunk(id: string): string | undefined {
  const path = id.replace(/\\/g, "/").split("?")[0];
  if (/\/src\/components\/hosted\//.test(path)
    || /\/src\/runtime\/domains\/hosted-tasks\.ts$/.test(path)) return "cloud-tasks";
  // Opening Files fetches its inspection views together, but React still mounts
  // the technical views only when requested. Shared command/checkpoint wrappers
  // stay outside: conversation controls also import those wrappers.
  if (/\/src\/components\/navigation\/(?:WorkspaceLibrary|NativeExecutionSetup|NativeCommandJobs|RepositoryFiles|RepositoryCopies|RepositoryCheckpoints|PullRequestReview)\.tsx$/.test(path)
    || /\/src\/components\/navigation\/(?:repository-files|repository-copies|repository-checkpoints|pull-request-review)\.css$/.test(path)) return "repository-inspection";
  if (/\/src\/runtime\/domains\/(?:coding|repository-copies)\.ts$/.test(path)) return "repository-inspection";
  // These editors share a deferred setup boundary. Appearance and model pickers
  // are deliberately excluded: onboarding and conversation import them too.
  if (/\/src\/components\/agents\/(?:AgentEditor|AgentLearningDialog)\.tsx$/.test(path)
    || /\/src\/components\/projects\/(?:ProjectDetailsDialog|ProjectContextPanel|ConversationDialogs|TeamReadiness)\.tsx$/.test(path)) return "workspace-editors";
  // Load the optional workspace inspection surfaces together without mounting
  // inactive views. Do not include hosted-computer helpers: execution also owns
  // them. History, artifact preview and CopyButton have conversation accounting.
  if (/\/src\/shell\/ComputerInspector\.tsx$/.test(path)
    || /\/src\/components\/navigation\/WorkspaceMemories\.tsx$/.test(path)
    || /\/src\/components\/navigation\/workspace-memories\.css$/.test(path)
    || /\/src\/components\/conversation\/SideChats\.tsx$/.test(path)
    || /\/src\/components\/search\/(?:SearchOverlay|SearchResults)\.tsx$/.test(path)
    || /\/src\/components\/search\/search\.css$/.test(path)) return "workspace-inspection";
  return undefined;
}

const inputDependency = (id: string) => /\/node_modules\/(?:react-textarea-autosize|use-composed-ref|use-latest|use-isomorphic-layout-effect)\//.test(id.replace(/\\/g, "/"));
const assistant = (id: string) => /\/node_modules\/@assistant-ui\//.test(id.replace(/\\/g, "/"));

/** Only move a dependency when EVERY incoming edge belongs to the assistant
 * input chain. Shared hooks stay shared if another consumer ever appears. */
export function assistantInputDependency(id: string, getModuleInfo: GetModuleInfo): boolean {
  if (!inputDependency(id)) return false;
  const pending = [id];
  const seen = new Set<string>();
  let owned = false;
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const info = getModuleInfo(next);
    if (!info || info.isEntry) return false;
    const importers = [...info.importers, ...info.dynamicImporters];
    if (!importers.length) return false;
    for (const importer of importers) {
      if (assistant(importer)) owned = true;
      else if (inputDependency(importer)) pending.push(importer);
      else return false;
    }
  }
  return owned;
}
