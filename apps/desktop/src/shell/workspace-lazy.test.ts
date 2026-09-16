import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const islands = [
  "../components/search/SearchOverlay",
  "../components/projects/ProjectDetailsDialog",
  "../components/navigation/WorkModeView",
  "./ExecutionWorker",
  "../components/agents/AgentEditor",
  "../components/pages/OnboardingPage",
  "../components/pages/SettingsPage",
  "../components/pages/MarketplacePage",
  "../components/settings/LocalSchedules",
  "../components/agents/AccountDialog",
  "./ComputerInspector",
];

describe("workspace lazy route islands", () => {
  it("keeps search, settings, marketplace, work, and execution islands lazy", () => {
    const source = readFileSync(join(here, "workspace-lazy.tsx"), "utf8");
    expect(source).toContain("import { lazy } from \"react\"");
    for (const specifier of islands) {
      expect(source, specifier).toContain(`import("${specifier}")`);
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
