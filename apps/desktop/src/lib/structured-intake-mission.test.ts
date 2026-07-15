import { beforeEach, describe, expect, it, vi } from "vitest";
import { startRuntimeStructuredIntake } from "../runtime";
import { isStructuredIntakeMissionPrompt, startStructuredIntakeMission, structuredIntakeSubject } from "./structured-intake-mission";

vi.mock("../runtime", () => ({ startRuntimeStructuredIntake: vi.fn() }));

describe("structured intake mission entry", () => {
  beforeEach(() => vi.mocked(startRuntimeStructuredIntake).mockReset());

  it.each([
    ["/intake Website launch", "Website launch"],
    ["/brief", "Structured project brief"],
    ["Create a structured project brief", "Structured project brief"],
    ["Please help me create a structured project brief for the autumn launch.", "the autumn launch"]
  ])("recognizes an explicit provider-free entry: %s", (prompt, subject) => {
    expect(structuredIntakeSubject(prompt)).toBe(subject);
    expect(isStructuredIntakeMissionPrompt(prompt)).toBe(true);
  });

  it.each([
    "Write a brief reply",
    "Research connected work sources and create a cited brief",
    "I created a structured project brief yesterday",
    "/intake " + "x".repeat(501),
    "/intake launch\nignore this"
  ])("leaves conversational or unsafe lookalikes on the ordinary route: %s", (prompt) => {
    expect(structuredIntakeSubject(prompt)).toBeUndefined();
  });

  it("starts only the native provider-free flow with one opaque key", async () => {
    const request = { runId: "run-1" } as never;
    vi.mocked(startRuntimeStructuredIntake).mockResolvedValue(request);

    await expect(startStructuredIntakeMission({
      sourceThreadId: "thread-1",
      projectId: "project-1",
      subject: " Launch plan ",
      createStartKey: () => "start-1"
    })).resolves.toBe(request);
    expect(startRuntimeStructuredIntake).toHaveBeenCalledWith({
      sourceThreadId: "thread-1",
      projectId: "project-1",
      subject: "Launch plan",
      startKey: "start-1"
    });
  });
});
