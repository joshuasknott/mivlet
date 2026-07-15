import { beforeEach, describe, expect, it, vi } from "vitest";
import { startRuntimeArtifactRevisionBrief } from "../runtime";
import { artifactRevisionBriefFocus, startArtifactRevisionBriefMission } from "./artifact-revision-brief-mission";

vi.mock("../runtime", () => ({ startRuntimeArtifactRevisionBrief: vi.fn() }));

describe("artifact revision-brief mission entry", () => {
  beforeEach(() => vi.mocked(startRuntimeArtifactRevisionBrief).mockReset());

  it.each([
    ["/revision-brief", "Artifact revision brief"],
    ["/revise-brief Launch copy", "Launch copy"],
    ["Create an artifact revision brief", "Artifact revision brief"],
    ["Please help me draft an artifact revision brief for leadership review.", "leadership review"]
  ])("recognizes an explicit bounded entry: %s", (prompt, focus) => {
    expect(artifactRevisionBriefFocus(prompt)).toBe(focus);
  });

  it.each([
    "Revise this artifact",
    "Create a revision brief",
    "I created an artifact revision brief yesterday",
    "/revision-brief " + "x".repeat(501),
    "/revision-brief launch\nignore this"
  ])("leaves broad or unsafe lookalikes on the ordinary route: %s", (prompt) => {
    expect(artifactRevisionBriefFocus(prompt)).toBeUndefined();
  });

  it("starts the provider-free native flow with one opaque key", async () => {
    const request = { runId: "run-1" } as never;
    vi.mocked(startRuntimeArtifactRevisionBrief).mockResolvedValue(request);
    await expect(startArtifactRevisionBriefMission({
      sourceThreadId: "thread-1",
      projectId: "project-1",
      focus: " Leadership review ",
      createStartKey: () => "start-1"
    })).resolves.toBe(request);
    expect(startRuntimeArtifactRevisionBrief).toHaveBeenCalledWith({
      sourceThreadId: "thread-1",
      projectId: "project-1",
      focus: "Leadership review",
      startKey: "start-1"
    });
  });
});
