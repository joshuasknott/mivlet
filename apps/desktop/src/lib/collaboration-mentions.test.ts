import { describe, expect, it } from "vitest";
import {
  mentionedAgentIds,
  resolveMentionResponder,
  selectResponder,
} from "./collaboration-mentions";

const participants = [
  { agentId: "lead", name: "Ada" },
  { agentId: "research", name: "Researcher" },
  { agentId: "review", name: "Ada Lovelace" },
];

describe("explicit @mentions", () => {
  it("resolves a named participant in appearance order", () => {
    expect(
      mentionedAgentIds("Please ask @Researcher and @Ada Lovelace.", participants),
    ).toEqual(["research", "review"]);
  });

  it("is case-insensitive and prefers the longest participant name", () => {
    expect(mentionedAgentIds("@ada lovelace review this", participants)).toEqual([
      "review",
    ]);
    expect(mentionedAgentIds("ping @ADA now", participants)).toEqual(["lead"]);
  });

  it("ignores unknown tokens, email addresses and plugin mentions", () => {
    expect(
      mentionedAgentIds("mail me at ada@example.com about @not-a-participant", participants),
    ).toEqual([]);
    expect(mentionedAgentIds("@connector-id should not route", participants)).toEqual(
      [],
    );
  });

  it("selects the first mention as the exact responder without a coordinator", () => {
    expect(
      resolveMentionResponder("Hey @Researcher, then @Ada.", participants),
    ).toEqual({ responderId: "research", mentionedIds: ["research", "lead"] });
    expect(resolveMentionResponder("No one named", participants)).toBeNull();
  });

  it("applies baseline responder selection without broadcasting", () => {
    expect(
      selectResponder("No names here", participants, {
        selectedRecipientId: "review",
      }),
    ).toEqual({
      responderId: "review",
      mentionedIds: [],
      source: "selected",
    });
    expect(
      selectResponder("No names here", participants, {
        coordinatorId: "lead",
      }),
    ).toEqual({
      responderId: "lead",
      mentionedIds: [],
      source: "coordinator",
    });
    expect(
      selectResponder("Ask @Researcher", participants, {
        selectedRecipientId: "lead",
        coordinatorId: "lead",
      }),
    ).toEqual({
      responderId: "research",
      mentionedIds: ["research"],
      source: "mention",
    });
    // A coordinator-less Project Team with no explicit choice fails closed.
    expect(selectResponder("Help", participants, {})).toBeNull();
    expect(
      selectResponder("Help", participants, { selectedRecipientId: "removed" }),
    ).toBeNull();
  });
});
