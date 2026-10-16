import type { SearchNavigationTarget } from "../../lib/search/navigation";

export type RightPanelTab =
  | {
      id: string;
      kind: "artifact";
      title: string;
      output: string;
      agentId: string;
      conversationId?: string;
      messageId?: string;
      sourceRevisionId?: string;
    }
  | { id: string; kind: "chat"; title: string; roomId: string }
  | { id: string; kind: "web"; title: string; url: string }
  | { id: string; kind: "mcp-app"; title: string }
  | {
      id: string;
      kind: "file";
      title: string;
      target?: Extract<
        SearchNavigationTarget,
        { type: "artifact" | "knowledge-file" }
      >;
      text?: string;
      imageDataUrl?: string;
    }
  | { id: string; kind: "output"; title: string; outputId: string };

export type PanelPage =
  "activity" | "files" | "memory" | "history" | "chats" | "schedules";
export type RightPanelState = {
  page: PanelPage;
  content: { tab: RightPanelTab; scopeKey: string } | null;
};
export type RightPanelAction =
  | { type: "open"; tab: RightPanelTab; scopeKey: string }
  | { type: "select"; page: PanelPage }
  | { type: "close" }
  | { type: "reset" };

export function reduceRightPanel(
  state: RightPanelState,
  action: RightPanelAction,
): RightPanelState {
  if (action.type === "reset") return { page: "activity", content: null };
  if (action.type === "select") return { page: action.page, content: null };
  if (action.type === "open")
    return {
      ...state,
      content: { tab: action.tab, scopeKey: action.scopeKey },
    };
  return { ...state, content: null };
}
