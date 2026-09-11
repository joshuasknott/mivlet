import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConversationScroll } from "./useConversationScroll";

function ScrollHarness({ revision }: { revision: number }) {
  const scroll = useConversationScroll("thread", revision);
  return <div data-testid="scroll" ref={scroll.scrollRef} onScroll={scroll.onScroll}>
    <div data-testid="content" ref={scroll.contentRef} />
    {scroll.showLatest ? <div data-testid="latest" /> : null}
    <button type="button" onClick={scroll.toLatest}>latest</button>
  </div>;
}

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
  it("does not yank the viewport when a revision lands between the reader's scroll input and its scroll event", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    element.scrollTop = 1200;
    rerender({ revision: 1 });
    expect(element.scrollTop).toBe(1200);
    expect(result.current.showLatest).toBe(true);
  });
  it("re-anchors to the growing bottom while the reader stays pinned", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    Object.defineProperty(element, "scrollHeight", { value: 2300 });
    rerender({ revision: 1 });
    expect(element.scrollTop).toBe(2300);
    Object.defineProperty(element, "scrollHeight", { value: 2600 });
    rerender({ revision: 2 });
    expect(element.scrollTop).toBe(2600);
  });
  it("preserves the read position when delayed images or artifacts grow the feed below", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    act(() => { element.scrollTop = 300; result.current.onScroll(); });
    Object.defineProperty(element, "scrollHeight", { value: 2600 });
    rerender({ revision: 1 });
    expect(element.scrollTop).toBe(300);
    expect(result.current.showLatest).toBe(true);
  });
  it("does not yank the reader after expanding reasoning or tool content", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    act(() => result.current.pauseFollowing());
    Object.defineProperty(element, "scrollHeight", { value: 2400 });
    rerender({ revision: 1 });
    expect(element.scrollTop).toBe(2000);
    expect(result.current.showLatest).toBe(false);
    act(() => { element.scrollTop = 1900; result.current.onScroll(); });
    Object.defineProperty(element, "scrollHeight", { value: 2800 });
    rerender({ revision: 2 });
    expect(element.scrollTop).toBe(2800);
  });
  it("keeps the read position when layout changes alter the viewport", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    act(() => { element.scrollTop = 300; result.current.onScroll(); });
    Object.defineProperty(element, "clientHeight", { value: 400 });
    rerender({ revision: 1 });
    expect(element.scrollTop).toBe(300);
    expect(result.current.showLatest).toBe(true);
  });
  it("preserves the read position across a submitted message and stop or failure notices", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    act(() => { element.scrollTop = 300; result.current.onScroll(); });
    for (const height of [2300, 2500, 2700]) {
      Object.defineProperty(element, "scrollHeight", { value: height });
      rerender({ revision: height });
      expect(element.scrollTop).toBe(300);
      expect(result.current.showLatest).toBe(true);
    }
  });
  it("follows stop and failure notices from the bottom", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    for (const height of [2100, 2250, 2400]) {
      Object.defineProperty(element, "scrollHeight", { value: height });
      rerender({ revision: height });
      expect(element.scrollTop).toBe(height);
    }
  });
  it("anchors restored history at the bottom and preserves a later read position", () => {
    const { result, rerender } = renderHook(({ scope, revision }) => useConversationScroll(scope, revision), { initialProps: { scope: "thread-a", revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 600 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    rerender({ scope: "thread-b", revision: 1 });
    expect(element.scrollTop).toBe(600);
    Object.defineProperty(element, "scrollHeight", { value: 3000 });
    rerender({ scope: "thread-b", revision: 2 });
    expect(element.scrollTop).toBe(3000);
    act(() => { element.scrollTop = 400; result.current.onScroll(); });
    Object.defineProperty(element, "scrollHeight", { value: 3600 });
    rerender({ scope: "thread-b", revision: 3 });
    expect(element.scrollTop).toBe(400);
    expect(result.current.showLatest).toBe(true);
    act(() => result.current.toLatest());
    expect(element.scrollTop).toBe(3600);
  });
  it("treats a keyboard jump up like any scroll gesture", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    act(() => { element.scrollTop = 1100; result.current.onScroll(); });
    rerender({ revision: 1 });
    expect(element.scrollTop).toBe(1100);
    expect(result.current.showLatest).toBe(true);
  });
  it("resumes following only after the reader returns to the bottom or presses the button", () => {
    const { result, rerender } = renderHook(({ revision }) => useConversationScroll("thread", revision), { initialProps: { revision: 0 } });
    const element = document.createElement("div");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { value: 500 } });
    result.current.scrollRef.current = element;
    act(() => result.current.toLatest());
    act(() => { element.scrollTop = 300; result.current.onScroll(); });
    Object.defineProperty(element, "scrollHeight", { value: 2300 });
    rerender({ revision: 1 });
    expect(element.scrollTop).toBe(300);
    act(() => { element.scrollTop = 1790; result.current.onScroll(); });
    Object.defineProperty(element, "scrollHeight", { value: 2600 });
    rerender({ revision: 2 });
    expect(element.scrollTop).toBe(2600);
  });
  it("re-anchors through the ResizeObserver for sizing that changes without a revision, and disconnects on unmount", () => {
    let disconnected = 0;
    const instances: { callback: (entries: ResizeObserverEntry[]) => void }[] = [];
    class MockResizeObserver {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) { instances.push({ callback }); }
      observe() {}
      unobserve() {}
      disconnect() { disconnected += 1; }
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const view = render(<ScrollHarness revision={0} />);
    const element = screen.getByTestId("scroll");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 500 } });
    act(() => screen.getByRole("button", { name: "latest" }).click());
    expect(element.scrollTop).toBe(1000);
    Object.defineProperty(element, "scrollHeight", { value: 1300 });
    act(() => instances[0].callback([]));
    expect(element.scrollTop).toBe(1300);
    act(() => { element.scrollTop = 300; });
    Object.defineProperty(element, "scrollHeight", { value: 1700 });
    act(() => instances[0].callback([]));
    expect(element.scrollTop).toBe(300);
    expect(screen.getByTestId("latest")).toBeTruthy();
    view.unmount();
    expect(disconnected).toBe(1);
    vi.unstubAllGlobals();
  });
});
