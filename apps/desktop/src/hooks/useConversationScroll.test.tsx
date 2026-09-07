import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useConversationScroll } from "./useConversationScroll";

describe("conversation scroll following", () => {
  it("does not show the jump button for short conversations, disclosure clicks or content growth alone", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 300 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.pauseFollowing());
    rerender({ revision: 1 });
    expect(result.current.showLatest).toBe(false);
    Object.defineProperty(element, "scrollHeight", { value: 1200 });
    rerender({ revision: 2 });
    expect(result.current.showLatest).toBe(false);
    act(() => result.current.toLatest());
    act(() => { element.scrollTop = 100; result.current.onScroll(); });
    expect(result.current.showLatest).toBe(true);
    Object.defineProperty(element, "scrollHeight", { value: 300 });
    rerender({ revision: 3 });
    expect(result.current.showLatest).toBe(false);
  });
  it("preserves reading position, resumes on Latest and resets for another thread", () => {
    const { result, rerender } = renderHook(({ scope, revision }) => useConversationScroll(scope, revision), { initialProps: { scope: "thread-a", revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    expect(element.scrollTop).toBe(2000);
    act(() => { element.scrollTop = 300; result.current.onScroll(); });
    rerender({ scope: "thread-a", revision: 1 });
    expect(element.scrollTop).toBe(300);
    expect(result.current.showLatest).toBe(true);
    act(() => result.current.toLatest());
    expect(result.current.showLatest).toBe(false);
    Object.defineProperty(element, "scrollHeight", { value: 2200 });
    rerender({ scope: "thread-a", revision: 2 });
    expect(element.scrollTop).toBe(2200);
    act(() => { element.scrollTop = 200; result.current.onScroll(); });
    rerender({ scope: "thread-b", revision: 3 });
    expect(result.current.showLatest).toBe(false);
    expect(element.scrollTop).toBe(2200);
  });
});
