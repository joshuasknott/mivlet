import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseArtifactAction } from "./ResponseArtifactAction";
import * as runtime from "../runtime";

const version1 = {
  id: "version-1",
  artifactId: "artifact-1",
  version: 1,
  content: { kind: "inline", text: "Answer", media: {}, contentHash: {} },
  citations: [{ id: "citation-1", label: "Roadmap" }],
  lineage: []
};

const saved = {
  artifact: { id: "artifact-1", title: "Answer", status: "draft", revision: 1, currentVersionId: "version-1", context: { threadId: "thread-1" }, reviews: [] },
  currentVersion: version1,
  versions: [version1],
  sourceMessageId: "message-1"
} as unknown as runtime.RuntimeArtifactBundle;

vi.mock("../runtime", () => ({
  createRuntimeResponseArtifact: vi.fn(async () => saved),
  appendRuntimeArtifactVersion: vi.fn(),
  reviewRuntimeArtifact: vi.fn()
}));

describe("ResponseArtifactAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runtime.createRuntimeResponseArtifact).mockResolvedValue(saved);
  });

  it("saves and opens a sourced assistant response", async () => {
    const onSaved = vi.fn();
    const { rerender } = render(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[{ sourceId: "source-1", title: "Roadmap", snippet: "Evidence" } as never]} onSaved={onSaved} />);
    await userEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(runtime.createRuntimeResponseArtifact).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      citations: [expect.objectContaining({ sourceId: "source-1" })]
    }));

    rerender(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={saved} onSaved={onSaved} />);
    expect(screen.getByRole("region", { name: "Saved artifact" })).toHaveTextContent("Answer");
    await userEvent.click(screen.getByRole("button", { name: "Hide artifact" }));
    await userEvent.click(screen.getByRole("button", { name: "View artifact" }));
    expect(screen.getByRole("region", { name: "Saved artifact" })).toHaveTextContent("Answer");
    expect(screen.getByRole("list", { name: "Artifact sources" })).toHaveTextContent("Roadmap");
  });

  it("renders history and appends an immutable second version", async () => {
    const user = userEvent.setup();
    const version2 = { ...version1, id: "version-2", version: 2, content: { ...version1.content, text: "Revised answer" } };
    const revised = {
      ...saved,
      artifact: { ...saved.artifact, revision: 1, currentVersionId: "version-2" },
      currentVersion: version2,
      versions: [version1, version2]
    } as unknown as runtime.RuntimeArtifactBundle;
    vi.mocked(runtime.appendRuntimeArtifactVersion).mockResolvedValue(revised);
    const onSaved = vi.fn();
    const view = render(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={saved} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: "View artifact" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit artifact markdown" });
    await user.clear(editor);
    await user.type(editor, "Revised answer");
    await user.click(screen.getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(revised));
    expect(runtime.appendRuntimeArtifactVersion).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      expectedRevision: 1,
      expectedCurrentVersionId: "version-1",
      content: "Revised answer"
    });
    expect(version1.content.text).toBe("Answer");

    view.rerender(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={revised} onSaved={onSaved} />);
    expect(screen.getByText("Version 2")).toBeInTheDocument();
    await user.click(screen.getByText("Version history (2)"));
    expect(screen.getByText("Version 1")).toBeInTheDocument();
    expect(screen.getByText("Version 2 - Current")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Artifact sources" })).toHaveTextContent("Roadmap");
  });

  it("shows a stale edit conflict plainly and keeps the editor open", async () => {
    vi.mocked(runtime.appendRuntimeArtifactVersion).mockRejectedValue(
      new Error("This artifact changed elsewhere. Reopen it before saving a new version.")
    );
    const user = userEvent.setup();
    render(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={saved} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "View artifact" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save new version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(screen.getByRole("textbox", { name: "Edit artifact markdown" })).toBeInTheDocument();
  });

  it("shows calm review states and exact actions", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const inReview = {
      ...saved,
      artifact: { ...saved.artifact, status: "in-review", revision: 2, reviews: [{ id: "review-1", status: "in-review", versionId: "version-1" }] }
    } as unknown as runtime.RuntimeArtifactBundle;
    const changesRequested = {
      ...inReview,
      artifact: { ...inReview.artifact, status: "changes-requested", revision: 3 }
    } as unknown as runtime.RuntimeArtifactBundle;
    vi.mocked(runtime.reviewRuntimeArtifact)
      .mockResolvedValueOnce(inReview)
      .mockResolvedValueOnce(changesRequested);
    const view = render(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={saved} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: "View artifact" }));
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request review" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(inReview));
    expect(runtime.reviewRuntimeArtifact).toHaveBeenLastCalledWith({
      artifactId: "artifact-1",
      versionId: "version-1",
      expectedRevision: 1,
      action: "request-review"
    });
    expect(screen.getByRole("status")).toHaveTextContent("Review requested");

    view.rerender(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={inReview} onSaved={onSaved} />);
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const changes = screen.getByRole("textbox", { name: "Changes needed" });
    expect(changes).toHaveAttribute("maxlength", "2000");
    await user.type(changes, "Clarify the conclusion.");
    await user.click(screen.getByRole("button", { name: "Confirm changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(changesRequested));
    expect(runtime.reviewRuntimeArtifact).toHaveBeenLastCalledWith({
      artifactId: "artifact-1",
      versionId: "version-1",
      expectedRevision: 2,
      action: "request-changes",
      requestedChanges: ["Clarify the conclusion."]
    });
  });

  it("shows accepted as final until editing creates a new draft", async () => {
    const accepted = {
      ...saved,
      artifact: { ...saved.artifact, status: "accepted", revision: 3 }
    } as unknown as runtime.RuntimeArtifactBundle;
    const user = userEvent.setup();
    render(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={accepted} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "View artifact" }));
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });
});
