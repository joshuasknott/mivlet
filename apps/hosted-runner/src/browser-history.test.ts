import { describe, expect, it } from "vitest";
import {
  appendBrowserHistory,
  browserNavigationSnapshot,
  moveBrowserHistory,
  replaceCurrentBrowserHistory,
  type BrowserHistoryState
} from "./browser-history";

describe("bounded hosted browser history", () => {
  it("moves back and forward without inventing a browser-native target", () => {
    const history: BrowserHistoryState = {
      entries: ["https://one.example/", "https://two.example/", "https://three.example/"],
      index: 2
    };
    const back = moveBrowserHistory(history, "back");
    expect(back).toEqual({
      target: "https://two.example/",
      history: { entries: history.entries, index: 1 }
    });
    expect(browserNavigationSnapshot(back!.history)).toEqual({ canGoBack: true, canGoForward: true });
    expect(moveBrowserHistory(back!.history, "forward")?.target).toBe("https://three.example/");
  });

  it("truncates forward history after a new navigation and retains only 32 public targets", () => {
    const branched = appendBrowserHistory({
      entries: ["https://one.example/", "https://two.example/", "https://old.example/"],
      index: 1
    }, "https://new.example/");
    expect(branched).toEqual({
      entries: ["https://one.example/", "https://two.example/", "https://new.example/"],
      index: 2
    });

    let bounded: BrowserHistoryState = { entries: [], index: -1 };
    for (let index = 0; index < 40; index += 1) {
      bounded = appendBrowserHistory(bounded, `https://page-${index}.example/`);
    }
    expect(bounded.entries).toHaveLength(32);
    expect(bounded.entries[0]).toBe("https://page-8.example/");
    expect(bounded.index).toBe(31);
  });

  it("fails closed at either edge and records a safe redirect at the current index", () => {
    expect(moveBrowserHistory({ entries: ["https://one.example/"], index: 0 }, "back")).toBeNull();
    expect(moveBrowserHistory({ entries: ["https://one.example/"], index: 0 }, "forward")).toBeNull();
    expect(replaceCurrentBrowserHistory({
      entries: ["https://one.example/", "https://redirect.example/"],
      index: 0
    }, "https://final.example/")).toEqual({
      entries: ["https://final.example/", "https://redirect.example/"],
      index: 0
    });
  });
});
