import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

const narrowQuery = "(max-width: 850px)";
const phoneQuery = "(max-width: 700px)";

function mockMediaQuery() {
  const media = Object.assign(new EventTarget(), { matches: false });
  return {
    media,
    add: vi.spyOn(media, "addEventListener"),
    remove: vi.spyOn(media, "removeEventListener"),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps one subscription without reattaching on same-query rerenders", () => {
  const { media, add, remove } = mockMediaQuery();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  const { rerender, unmount } = renderHook(() => useMediaQuery(narrowQuery));

  for (let i = 0; i < 10; i++) rerender();

  expect({
    adds: add.mock.calls.length,
    removes: remove.mock.calls.length,
  }).toEqual({
    adds: 1,
    removes: 0,
  });
  unmount();
  expect(remove.mock.calls).toEqual(add.mock.calls);
});

it("updates when the media changes and switches listeners when the query changes", () => {
  const narrow = mockMediaQuery();
  const phone = mockMediaQuery();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) =>
      query === narrowQuery ? narrow.media : phone.media,
    ),
  );
  const { result, rerender, unmount } = renderHook(
    ({ query }) => useMediaQuery(query),
    {
      initialProps: { query: narrowQuery },
    },
  );

  expect(result.current).toBe(false);
  act(() => {
    narrow.media.matches = true;
    narrow.media.dispatchEvent(new Event("change"));
  });
  expect(result.current).toBe(true);

  rerender({ query: phoneQuery });
  expect(result.current).toBe(false);
  expect(narrow.remove.mock.calls).toEqual(narrow.add.mock.calls);
  expect(phone.add).toHaveBeenCalledOnce();

  unmount();
  expect(phone.remove.mock.calls).toEqual(phone.add.mock.calls);
});
