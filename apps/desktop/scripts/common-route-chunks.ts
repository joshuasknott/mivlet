type GetModuleInfo = (id: string) => {
  isEntry: boolean;
  importers: readonly string[];
  dynamicImporters: readonly string[];
} | null;

/** Related deferred views share compression/requests. Every cohort stays in
 * common accounting; separately budgeted conversation engines stay separate. */
export function commonRouteChunk(id: string): string | undefined {
  const path = id.replace(/\\/g, "/").split("?")[0];
  // Onboarding already loads the appearance controls and both stylesheets.
  // Share their JS/CSS compression; the optional agent editor also fetches
  // these small onboarding definitions without mounting the page.
  if (/\/src\/components\/pages\/FirstAgentOnboardingPage\.tsx$/.test(path)
    || /\/src\/components\/agents\/(?:AgentAppearancePicker\.tsx|AgentColourPicker\.tsx|agent-appearance\.css)$/.test(path)
    || /\/src\/styles\/routes\/first-agent-onboarding\.css$/.test(path)) return "FirstAgentOnboardingPage";
  // These modules already belong to the execution worker's static closure.
  // One common-accounted request lets their strings and wrappers compress
  // together without adding optional workspace views to startup or execution.
  // Settings and conversation now fetch this code too; importing these pure
  // definitions does not mount a worker or dispatch native/remote operations.
  if (/\/src\/shell\/(?:ExecutionWorker\.tsx|useExecutionController\.ts)$/.test(path)
    || /\/src\/hooks\/native-agent\/(?:run|events|useNativeAgent|context|retry|persistence|providers|cancellation|recovery|runtime|text-presentation)\.ts$/.test(path)
    || /\/src\/hooks\/(?:useHostedBrowserController|useHostedComputer)\.ts$/.test(path)
    || /\/src\/lib\/(?:desktop-tool-runtime|computer-task-executor|collaboration-context|conversation-compaction|shared-execution-attachments|computer-instructions|computer-tools|provider-route-selection|attempt-persistence|provider-continuation|generated-ui-instructions|coordination-resources|workspace-agent-directory|context-selection|hosted-computer-scope|execution-attachments|conversation-presentation|connector-chat|mcp-app-descriptor)\.ts$/.test(path)
    || /\/src\/runtime\/domains\/(?:provider-continuation|hosted-computer|tools)\.ts$/.test(path)
    || /\/src\/components\/marketplace\/marketplace-catalog\.ts$/.test(path)
    || /\/packages\/connectors\/src\/providers\/routing\.ts$/.test(path)) return "ExecutionWorker";
  if (/\/src\/components\/hosted\//.test(path)
    || /\/src\/runtime\/domains\/hosted-tasks\.ts$/.test(path)) return "workspace-tools";
  // Share the deferred settings, marketplace and usage request with the other
  // optional tools. The eager modal and shared connector catalogues stay out.
  if (/\/src\/components\/settings\/(?!SettingsModal\.tsx$)[^/]+\.tsx$/.test(path)
    || /\/src\/components\/pages\/MarketplacePage\.tsx$/.test(path)
    || /\/src\/components\/usage\/(?:UsageDashboard|UsageHistory|UsageChart|UsageModelDetail|UsagePriceEditor|UsageSources|SubscriptionUsage)\.tsx$/.test(path)
    || /\/src\/components\/usage\/(?:usage-data\.ts|usage-history\.css|provider-usage\.css)$/.test(path)
    || /\/src\/components\/marketplace\/(?!(?:remote-connectors|marketplace-catalog)\.ts$)[^/]+\.tsx?$/.test(path)
    || /\/src\/components\/PluginPanel\.tsx$/.test(path)
    || /\/src\/components\/navigation\/(?:MemoryRecordCard|PanelPagination)\.tsx$/.test(path)
    || /\/src\/components\/settings\/[^/]+\.css$/.test(path)
    || /\/src\/runtime\/domains\/(?:hosted-repositories|phone-relay)\.ts$/.test(path)
    || /\/packages\/protocol\/src\/domains\/(?:hosted-task-json|hosted-public-web)\.ts$/.test(path)) return "workspace-tools";
  // The optional workspace panels share one deferred code request on local disk.
  // Opening any one also fetches cloud controls and the other editors/inspectors; React mounts
  // only the selected view. Shared command/checkpoint wrappers
  // stay outside: conversation controls also import those wrappers.
  if (/\/src\/components\/navigation\/(?:WorkspaceLibrary|NativeExecutionSetup|NativeCommandJobs|RepositoryFiles|RepositoryCopies|RepositoryCheckpoints|PullRequestReview)\.tsx$/.test(path)
    || /\/src\/components\/navigation\/(?:native-command-jobs|repository-files|repository-copies|repository-checkpoints|pull-request-review)\.css$/.test(path)
    || /\/src\/hooks\/useWorkspaceLocalFiles\.ts$/.test(path)) return "workspace-tools";
  if (/\/src\/runtime\/domains\/(?:coding|repository-copies)\.ts$/.test(path)) return "workspace-tools";
  // These editors share a deferred setup boundary. Appearance and model pickers
  // are deliberately excluded: onboarding and conversation import them too.
  if (/\/src\/components\/agents\/(?:AgentEditor|AgentLearningDialog)\.tsx$/.test(path)
    || /\/src\/components\/projects\/(?:ProjectDetailsDialog|ProjectContextPanel|ProjectFiles|ConversationDialogs|TeamReadiness)\.tsx$/.test(path)
    || /\/src\/components\/projects\/projects\.css$/.test(path)) return "workspace-tools";
  // Load the optional workspace inspection surfaces together without mounting
  // inactive views. Do not include hosted-computer helpers: execution also owns
  // them. History, artifact preview and CopyButton have conversation accounting.
  if (/\/src\/shell\/ComputerInspector\.tsx$/.test(path)
    || /\/src\/components\/agents\/(?:LiveWorkRail|NativeComputerPanel|CloudComputerPanel|AgentComputerChoice)\.tsx$/.test(path)
    || /\/src\/hooks\/(?:useCloudComputer|useCloudViewer)\.ts$/.test(path)
    || /\/src\/runtime\/domains\/cloud-computers\.ts$/.test(path)
    || /\/src\/components\/navigation\/WorkspaceMemories\.tsx$/.test(path)
    || /\/src\/components\/navigation\/workspace-memories\.css$/.test(path)
    || /\/src\/components\/conversation\/SideChats\.tsx$/.test(path)
    || /\/src\/components\/conversation\/side-chats-compact\.css$/.test(path)
    || /\/src\/components\/search\/(?:SearchOverlay|SearchResults)\.tsx$/.test(path)
    || /\/src\/components\/search\/search\.css$/.test(path)
    || /\/src\/lib\/search\/(?:useWorkspaceSearch|results)\.ts$/.test(path)
    || /\/src\/runtime\/domains\/search\.ts$/.test(path)) return "workspace-tools";
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
