import type { HostedBrowserSnapshot } from "@fable/protocol";

export const MAX_BROWSER_HISTORY = 32;

export interface BrowserHistoryState {
  entries: string[];
  index: number;
}

export function appendBrowserHistory(history: BrowserHistoryState, url: string): BrowserHistoryState {
  if (history.index >= 0 && history.entries[history.index] === url) return history;
  const entries = [...history.entries.slice(0, history.index + 1), url];
  if (entries.length <= MAX_BROWSER_HISTORY) return { entries, index: entries.length - 1 };
  return { entries: entries.slice(-MAX_BROWSER_HISTORY), index: MAX_BROWSER_HISTORY - 1 };
}

export function replaceCurrentBrowserHistory(history: BrowserHistoryState, url: string): BrowserHistoryState {
  if (history.index < 0 || history.index >= history.entries.length) return appendBrowserHistory(history, url);
  const entries = [...history.entries];
  entries[history.index] = url;
  return { entries, index: history.index };
}

export function moveBrowserHistory(
  history: BrowserHistoryState,
  direction: "back" | "forward"
): { history: BrowserHistoryState; target: string } | null {
  const index = history.index + (direction === "back" ? -1 : 1);
  if (index < 0 || index >= history.entries.length) return null;
  return { history: { entries: [...history.entries], index }, target: history.entries[index] };
}

export function browserNavigationSnapshot(history: BrowserHistoryState): HostedBrowserSnapshot["navigation"] {
  return {
    canGoBack: history.index > 0,
    canGoForward: history.index >= 0 && history.index < history.entries.length - 1
  };
}
