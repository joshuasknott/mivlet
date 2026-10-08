import { lazy } from "react";

/** Lazy route islands for the shell. Keep these off the eager workspace graph. */
export const SearchOverlay = lazy(() =>
  import("../components/search/SearchOverlay").then((module) => ({
    default: module.SearchOverlay,
  })),
);
export const ProjectDetailsDialog = lazy(() =>
  import("../components/projects/ProjectDetailsDialog").then((module) => ({
    default: module.ProjectDetailsDialog,
  })),
);
export const ExecutionWorker = lazy(() =>
  import("./ExecutionWorker").then((module) => ({
    default: module.ExecutionWorker,
  })),
);
export const AgentEditor = lazy(() =>
  import("../components/agents/AgentEditor").then((module) => ({
    default: module.AgentEditor,
  })),
);
export const OnboardingPage = lazy(() =>
  import("../components/pages/OnboardingPage").then((module) => ({
    default: module.OnboardingPage,
  })),
);
export const SettingsPage = lazy(() =>
  import("../components/pages/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
export const MarketplacePage = lazy(() =>
  import("../components/pages/MarketplacePage").then((module) => ({
    default: module.MarketplacePage,
  })),
);
export const LocalSchedules = lazy(() =>
  import("../components/settings/LocalSchedules").then((module) => ({
    default: module.LocalSchedules,
  })),
);
export const AccountDialog = lazy(() =>
  import("../components/agents/AccountDialog").then((module) => ({
    default: module.AccountDialog,
  })),
);
export const ComputerInspector = lazy(() =>
  import("./ComputerInspector").then((module) => ({
    default: module.ComputerInspector,
  })),
);
