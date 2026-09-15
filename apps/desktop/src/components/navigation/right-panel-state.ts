import type { SearchNavigationTarget } from "../../lib/search/navigation";

export type RightPanelTab =
  | {
      id: string;
      kind: "artifact";
      title: string;
      output: string;
      agentId: string;
    }
  | { id: string; kind: "chat"; title: string; roomId: string }
  | { id: string; kind: "web"; title: string; url: string }
  | {
      id: string;
      kind: "file";
      title: string;
      target: Extract<
        SearchNavigationTarget,
        { type: "artifact" | "knowledge-file" }
      >;
      text?: string;
    };

export type RightPanelState = { tabs: RightPanelTab[]; selected: string };
export type RightPanelAction =
  | { type: "open"; tab: RightPanelTab }
  | { type: "select"; id: string }
  | { type: "close"; id: string };

export function reduceRightPanel(
  state: RightPanelState,
  action: RightPanelAction,
): RightPanelState {
  if (action.type === "select") return { ...state, selected: action.id };
  if (action.type === "open")
    return {
      tabs: state.tabs.some((tab) => tab.id === action.tab.id)
        ? state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab))
        : [...state.tabs, action.tab],
      selected: action.tab.id,
    };
  const index = state.tabs.findIndex((tab) => tab.id === action.id);
  const tabs = state.tabs.filter((tab) => tab.id !== action.id);
  return {
    tabs,
    selected:
      state.selected === action.id
        ? (tabs[Math.max(0, index - 1)]?.id ?? "files")
        : state.selected,
  };
}
