// @vitest-environment node
import { expect, it } from "vitest";
import { assistantInputDependency, commonRouteChunk } from "./common-route-chunks";
import { conversationUpgradeAssetPattern, intelligentUiAssetPattern } from "../../../scripts/perf/assets.mjs";

const input = "/node_modules/react-textarea-autosize/dist/react-textarea-autosize.browser.esm.js";
const hook = "/node_modules/use-latest/dist/use-latest.esm.js";
const composer = "/node_modules/@assistant-ui/react/dist/primitives/composer/ComposerInput.js";
const app = "/src/components/Composer.tsx";
const graph = (edges: Record<string, string[]>, dynamic: Record<string, string[]> = {}) => (id: string) => id in edges
  ? { isEntry: false, importers: edges[id], dynamicImporters: dynamic[id] ?? [] } : null;

it("keeps every cohort under the unchanged common budget accounting", () => {
  for (const name of ["workspace-tools"]) {
    expect(conversationUpgradeAssetPattern.test(`${name}-hash.js`)).toBe(false);
    expect(intelligentUiAssetPattern.test(`${name}-hash.js`)).toBe(false);
  }
});

it("keeps correlated deferred cloud/repository fragments in common-accounted cohorts", () => {
  expect(commonRouteChunk("C:\\mivlet\\apps\\desktop\\src\\components\\hosted\\HostedTaskControls.tsx")).toBe("workspace-tools");
  expect(commonRouteChunk("/mivlet/apps/desktop/src/components/hosted/HostedProviderSettings.tsx")).toBe("workspace-tools");
  expect(commonRouteChunk("/mivlet/apps/desktop/src/runtime/domains/hosted-tasks.ts")).toBe("workspace-tools");
  for (const name of ["WorkspaceLibrary", "NativeExecutionSetup", "NativeCommandJobs", "RepositoryFiles", "RepositoryCopies", "RepositoryCheckpoints", "PullRequestReview"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/components/navigation/${name}.tsx`)).toBe("workspace-tools");
  for (const name of ["coding", "repository-copies"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/runtime/domains/${name}.ts`)).toBe("workspace-tools");
  expect(commonRouteChunk("/mivlet/apps/desktop/src/hooks/useWorkspaceLocalFiles.ts")).toBe("workspace-tools");
  // Do not move the eager shell, native shared runtime, unrelated route or
  // existing separately-accounted conversation/history feature into the group.
  for (const path of ["shell/WorkspaceContextPanel.tsx", "components/pages/SettingsPage.tsx", "runtime/domains/local-computer.ts", "runtime/domains/command-jobs.ts", "runtime/domains/repository-checkpoints.ts", "runtime/bridge.ts", "shell/WorkspaceHistory.tsx"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/${path}`)).toBeUndefined();
});

it("groups deferred workspace editors without pulling them into onboarding or conversation", () => {
  for (const path of ["agents/AgentEditor", "agents/AgentLearningDialog", "projects/ProjectDetailsDialog", "projects/ProjectContextPanel", "projects/ProjectFiles", "projects/ConversationDialogs", "projects/TeamReadiness"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/components/${path}.tsx`)).toBe("workspace-tools");
  for (const path of ["agents/AgentAppearancePicker", "agents/AgentColourPicker", "ModelPicker", "pages/OnboardingPage", "pages/FirstAgentOnboardingPage"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/components/${path}.tsx`)).toBeUndefined();
  expect(commonRouteChunk("/mivlet/apps/desktop/src/styles/agent-settings.css")).toBeUndefined();
});

it("groups optional inspection views while preserving execution and feature boundaries", () => {
  for (const path of ["shell/ComputerInspector.tsx", "components/agents/LiveWorkRail.tsx", "components/agents/NativeComputerPanel.tsx", "components/navigation/WorkspaceMemories.tsx", "components/navigation/workspace-memories.css", "components/conversation/SideChats.tsx", "components/search/SearchOverlay.tsx", "components/search/SearchResults.tsx", "components/search/search.css", "lib/search/useWorkspaceSearch.ts", "lib/search/results.ts", "runtime/domains/search.ts"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/${path}`)).toBe("workspace-tools");
  for (const path of ["shell/ExecutionWorker.tsx", "hooks/useHostedComputer.ts", "hooks/useHostedBrowserController.ts", "lib/hosted-computer-scope.ts", "runtime/domains/hosted-computer.ts", "shell/WorkspaceHistory.tsx", "components/conversation/ArtifactPreview.tsx", "components/CopyButton.tsx", "components/search/SearchFileDialog.tsx", "components/conversation/SideChatContextNotice.tsx"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/${path}`)).toBeUndefined();
});

it("moves the real input/hook chain only when all consumers belong to assistant-ui", () => {
  const info = graph({ [hook]: [input], [input]: [composer] });
  expect(assistantInputDependency(input, info)).toBe(true);
  expect(assistantInputDependency(hook, info)).toBe(true);
});

it("rejects a new eager or unrelated consumer, including through a shared hook", () => {
  expect(assistantInputDependency(input, graph({ [input]: [composer, app] }))).toBe(false);
  expect(assistantInputDependency(hook, graph({ [hook]: [input, app], [input]: [composer] }))).toBe(false);
  expect(assistantInputDependency(input, graph({ [input]: [composer] }, { [input]: [app] }))).toBe(false);
  expect(assistantInputDependency(input, () => ({ isEntry: true, importers: [composer], dynamicImporters: [] }))).toBe(false);
  expect(assistantInputDependency(input, () => null)).toBe(false);
  expect(assistantInputDependency("/node_modules/@babel/runtime/helpers/extends.js", graph({}))).toBe(false);
});

it("does not claim an orphaned or cyclic dependency without an assistant owner", () => {
  expect(assistantInputDependency(input, graph({ [input]: [] }))).toBe(false);
  expect(assistantInputDependency(input, graph({ [input]: [hook], [hook]: [input] }))).toBe(false);
});
