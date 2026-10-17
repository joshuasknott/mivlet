// @vitest-environment node
import { expect, it } from "vitest";
import { assistantInputDependency, commonRouteChunk } from "./common-route-chunks";

const input = "/node_modules/react-textarea-autosize/dist/react-textarea-autosize.browser.esm.js";
const hook = "/node_modules/use-latest/dist/use-latest.esm.js";
const composer = "/node_modules/@assistant-ui/react/dist/primitives/composer/ComposerInput.js";
const app = "/src/components/Composer.tsx";
const graph = (edges: Record<string, string[]>, dynamic: Record<string, string[]> = {}) => (id: string) => id in edges
  ? { isEntry: false, importers: edges[id], dynamicImporters: dynamic[id] ?? [] } : null;

it("keeps correlated deferred cloud/repository fragments in common-accounted cohorts", () => {
  expect(commonRouteChunk("C:\\mivlet\\apps\\desktop\\src\\components\\hosted\\HostedTaskControls.tsx")).toBe("cloud-tasks");
  expect(commonRouteChunk("/mivlet/apps/desktop/src/components/hosted/HostedProviderSettings.tsx")).toBe("cloud-tasks");
  expect(commonRouteChunk("/mivlet/apps/desktop/src/runtime/domains/hosted-tasks.ts")).toBe("cloud-tasks");
  for (const name of ["RepositoryFiles", "RepositoryCopies", "RepositoryCheckpoints", "PullRequestReview"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/components/navigation/${name}.tsx`)).toBe("repository-inspection");
  for (const name of ["coding", "repository-copies"])
    expect(commonRouteChunk(`/mivlet/apps/desktop/src/runtime/domains/${name}.ts`)).toBe("repository-runtime");
  // Do not move the eager shell, native shared runtime, unrelated route or
  // existing separately-accounted conversation/history feature into the group.
  for (const path of ["shell/WorkspaceContextPanel.tsx", "components/pages/SettingsPage.tsx", "components/navigation/WorkspaceLibrary.tsx", "runtime/domains/local-computer.ts", "runtime/domains/command-jobs.ts", "runtime/domains/repository-checkpoints.ts", "runtime/bridge.ts", "shell/WorkspaceHistory.tsx"])
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
