import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const routes = [
  ["SearchOverlay", "../components/search/SearchOverlay"],
  ["ProjectDetailsDialog", "../components/projects/ProjectDetailsDialog"],
  ["ExecutionWorker", "./ExecutionWorker"],
  ["AgentEditor", "../components/agents/AgentEditor"],
  ["OnboardingPage", "../components/pages/OnboardingPage"],
  ["SettingsPage", "../components/pages/SettingsPage"],
  ["MarketplacePage", "../components/pages/MarketplacePage"],
  ["LocalSchedules", "../components/settings/LocalSchedules"],
  ["AccountDialog", "../components/pages/SettingsPage"],
  ["ComputerInspector", "./ComputerInspector"],
] as const;
const islands = [
  ...routes.map(([, specifier]) => specifier),
  "../components/navigation/WorkspaceLibrary",
  "../components/agents/AccountDialog",
];

describe("workspace lazy route islands", () => {
  it("keeps search, settings, marketplace and execution islands lazy", () => {
    const source = readFileSync(join(here, "workspace-lazy.tsx"), "utf8");
    expect(source).toContain('import { lazy } from "react"');
    for (const [name, specifier] of routes) {
      const declaration = source
        .split("export const ")
        .find((part) => part.startsWith(`${name} = lazy(() =>`));
      expect(declaration, name).toBeDefined();
      expect(declaration, name).toContain(`import("${specifier}")`);
      expect(declaration, name).toContain(`default: module.${name}`);
    }
  });

  it("does not eagerly import those islands from the shell composition root", () => {
    const files = [
      "TeammateWorkspace.tsx",
      "ActiveWorkspace.tsx",
      "WorkspaceConversationChrome.tsx",
      "workspace-dialogs.tsx",
      "WorkspaceContextPanel.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(here, file), "utf8");
      for (const specifier of islands) {
        expect(source, `${file} ${specifier}`).not.toContain(
          `from "${specifier}"`,
        );
      }
    }
  });
});
