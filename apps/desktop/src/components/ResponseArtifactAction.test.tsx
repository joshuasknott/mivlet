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
  appendRuntimeArtifactVersion: vi.fn(),
  reviewRuntimeArtifact: vi.fn()
}));

describe("ResponseArtifactAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens versioned saved work without exposing internal artifact language", async () => {
    const onSaved = vi.fn();
    render(<ResponseArtifactAction existing={saved} onSaved={onSaved} />);
    await userEvent.click(screen.getByRole("button", { name: "View saved work Answer" }));
    expect(screen.getByRole("region", { name: "Saved work" })).toHaveTextContent("Answer");
    await userEvent.click(screen.getByRole("button", { name: "Hide saved work Answer" }));
    await userEvent.click(screen.getByRole("button", { name: "View saved work Answer" }));
    expect(screen.getByRole("list", { name: "Saved work sources" })).toHaveTextContent("Roadmap");
    expect(screen.queryByText(/artifact/i)).not.toBeInTheDocument();
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
    const view = render(<ResponseArtifactAction existing={saved} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: "View saved work Answer" }));
    await user.click(screen.getByRole("button", { name: "Edit Answer" }));
    const editor = screen.getByRole("textbox", { name: "Edit saved work" });
    await user.clear(editor);
    await user.type(editor, "Revised answer");
    await user.click(screen.getByRole("button", { name: "Save new version of Answer" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(revised));
    expect(runtime.appendRuntimeArtifactVersion).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      expectedRevision: 1,
      expectedCurrentVersionId: "version-1",
      content: "Revised answer"
    });
    expect(version1.content.text).toBe("Answer");

    view.rerender(<ResponseArtifactAction existing={revised} onSaved={onSaved} />);
    expect(screen.getByText("Version 2")).toBeInTheDocument();
    await user.click(screen.getByText("Version history (2)"));
    expect(screen.getByText("Version 1")).toBeInTheDocument();
    expect(screen.getByText("Version 2 - Current")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Saved work sources" })).toHaveTextContent("Roadmap");
  });

  it("shows a stale edit conflict plainly and keeps the editor open", async () => {
    vi.mocked(runtime.appendRuntimeArtifactVersion).mockRejectedValue(
      new Error("This artifact changed elsewhere. Reopen it before saving a new version.")
    );
    const user = userEvent.setup();
    render(<ResponseArtifactAction existing={saved} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "View saved work Answer" }));
    await user.click(screen.getByRole("button", { name: "Edit Answer" }));
    await user.click(screen.getByRole("button", { name: "Save new version of Answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(screen.getByRole("textbox", { name: "Edit saved work" })).toBeInTheDocument();
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
    const view = render(<ResponseArtifactAction existing={saved} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: "View saved work Answer" }));
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start private review for Answer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark Answer accepted" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start private review for Answer" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(inReview));
    expect(runtime.reviewRuntimeArtifact).toHaveBeenLastCalledWith({
      artifactId: "artifact-1",
      versionId: "version-1",
      expectedRevision: 1,
      action: "request-review"
    });
    expect(screen.getByRole("status")).toHaveTextContent("Private review started");

    view.rerender(<ResponseArtifactAction existing={inReview} onSaved={onSaved} />);
    expect(screen.getByText("Private review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Answer" })).not.toBeInTheDocument();
    expect(screen.getByText("Resolve private review before editing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark Answer accepted" })).toBeInTheDocument();
    const requestChanges = screen.getByRole("button", { name: "Request changes to Answer" });
    await user.click(requestChanges);
    const changes = screen.getByRole("textbox", { name: "Changes needed for Answer" });
    expect(changes).toHaveFocus();
    expect(changes).toHaveAttribute("maxlength", "2000");
    await user.click(screen.getByRole("button", { name: "Cancel requested changes for Answer" }));
    expect(requestChanges).toHaveFocus();
    await user.click(requestChanges);
    const changesAgain = screen.getByRole("textbox", { name: "Changes needed for Answer" });
    await user.type(changesAgain, "Clarify the conclusion.");
    await user.click(screen.getByRole("button", { name: "Confirm changes for Answer" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(changesRequested));
    expect(runtime.reviewRuntimeArtifact).toHaveBeenLastCalledWith({
      artifactId: "artifact-1",
      versionId: "version-1",
      expectedRevision: 2,
      action: "request-changes",
      requestedChanges: ["Clarify the conclusion."]
    });
    view.rerender(<ResponseArtifactAction existing={changesRequested} onSaved={onSaved} />);
    const changedStatus = screen.getByText("Changes requested", { exact: true });
    await waitFor(() => expect(changedStatus).toHaveFocus());
    expect(screen.getByRole("button", { name: "Edit Answer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start private review for Answer" })).not.toBeInTheDocument();
  });

  it("shows accepted as final until editing creates a new draft", async () => {
    const accepted = {
      ...saved,
      artifact: { ...saved.artifact, status: "accepted", revision: 3 }
    } as unknown as runtime.RuntimeArtifactBundle;
    const user = userEvent.setup();
    render(<ResponseArtifactAction existing={accepted} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "View saved work Answer" }));
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Answer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start private review for Answer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark Answer accepted" })).not.toBeInTheDocument();
  });
});
