import { describe, expect, it } from "vitest";
import { browserSessionAfterFence, hostedProcessReplayKind } from "./generation-fence";

describe("hosted process requestKey generation fence", () => {
  it("replays only when the stored process generation matches the capability", () => {
    expect(hostedProcessReplayKind(undefined, 2)).toBe("miss");
    expect(hostedProcessReplayKind(2, 2)).toBe("hit");
    expect(hostedProcessReplayKind(1, 2)).toBe("stale");
    expect(hostedProcessReplayKind(3, 2)).toBe("stale");
  });

  it("rejects a non-positive or non-integer expected generation", () => {
    expect(hostedProcessReplayKind(1, 0)).toBe("stale");
    expect(hostedProcessReplayKind(1, 1.5)).toBe("stale");
  });
});

describe("hosted browser session resume after generation fence", () => {
  const previous = {
    computerId: "computer-a",
    generation: 1,
    sessionId: "browser-run-old"
  };

  it("reconnects the stored Browser Run session only for the current generation", () => {
    expect(browserSessionAfterFence(previous, "computer-a", 1)).toEqual({
      destroyPrevious: false,
      resumeSessionId: "browser-run-old"
    });
  });

  it("does not reconnect an old Browser Run session after a generation mismatch", () => {
    expect(browserSessionAfterFence(previous, "computer-a", 2)).toEqual({
      destroyPrevious: true,
      resumeSessionId: null
    });
  });

  it("does not reconnect a session bound to a different computer", () => {
    expect(browserSessionAfterFence(previous, "computer-b", 1)).toEqual({
      destroyPrevious: true,
      resumeSessionId: null
    });
  });

  it("launches a new session when there is no stored browser state", () => {
    expect(browserSessionAfterFence(null, "computer-a", 1)).toEqual({
      destroyPrevious: false,
      resumeSessionId: null
    });
  });
});
