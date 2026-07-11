import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";
import {
  appendRuntimeArtifactVersion,
  createRuntimeResponseArtifact,
  exportRuntimeArtifact,
  listRuntimeThreadArtifacts,
  reviewRuntimeArtifact,
  searchRuntimeArtifacts,
  type RuntimeArtifactBundle
} from "./runtime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

function nativeBundle(workspaceId = "workspace-native"): RuntimeArtifactBundle {
  const version = {
    id: "version-1",
    artifactId: "artifact-1",
    version: 1,
    status: "available",
    createdAt: "2026-07-11T00:00:00.000Z",
    createdByInternalUserId: "user-1",
    content: { kind: "inline", text: "Answer", media: { mediaType: "text/markdown", byteLength: 6 }, contentHash: { algorithm: "sha-256", value: "hash" } },
    media: { mediaType: "text/markdown", byteLength: 6 },
    contentHash: { algorithm: "sha-256", value: "hash" },
    provenance: { kind: "run", observedAt: "2026-07-11T00:00:00.000Z" },
    citations: [],
    lineage: []
  };
  return {
    artifact: {
      id: "artifact-1",
      workspaceId,
      authority: "local",
      visibility: "member-private",
      ownerMemberId: "member-1",
      schemaVersion: 1,
      revision: 1,
      createdByInternalUserId: "user-1",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      kind: "document",
      status: "draft",
      title: "Answer",
      currentVersionId: "version-1",
      sourceProvenance: [],
      context: { threadId: "thread-1" },
      reviews: [],
      retention: { status: "active" }
    },
    currentVersion: version,
    versions: [version],
    sourceMessageId: "message-1"
  } as unknown as RuntimeArtifactBundle;
}

describe("artifact runtime revisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("never sends renderer citations or authority when creating natively", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    mocks.invoke.mockResolvedValue(nativeBundle());
    await createRuntimeResponseArtifact({
      threadId: "thread-1",
      messageId: "message-1",
      runId: "run-1",
      title: "Answer",
      content: "Answer",
      citations: [{ sourceId: "forged", title: "Forged" } as never]
    });
    const [, payload] = mocks.invoke.mock.calls[0];
    expect(mocks.invoke.mock.calls[0][0]).toBe("artifact_create_from_response");
    expect(payload.input).toEqual(expect.objectContaining({
      runId: "run-1",
      threadId: "thread-1",
      messageId: "message-1"
    }));
    expect(payload.input).not.toHaveProperty("citations");
    expect(payload.input).not.toHaveProperty("authority");
  });

  it("sends only the canonical CAS edit input to the native append command", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    const revised = nativeBundle();
    mocks.invoke.mockResolvedValue(revised);
    await appendRuntimeArtifactVersion({
      artifactId: "artifact-1",
      expectedRevision: 1,
      expectedCurrentVersionId: "version-1",
      content: "Revised"
    });
    const [, payload] = mocks.invoke.mock.calls[0];
    expect(mocks.invoke.mock.calls[0][0]).toBe("artifact_append_version");
    expect(payload.input.content).toEqual(expect.objectContaining({
      kind: "inline",
      text: "Revised",
      media: expect.objectContaining({ mediaType: "text/markdown", byteLength: 7 }),
      contentHash: expect.objectContaining({ algorithm: "sha-256" })
    }));
    expect(payload.input).not.toHaveProperty("citations");
    expect(payload.input).not.toHaveProperty("authority");
    expect(payload.input).not.toHaveProperty("lineage");
    expect(payload.input).not.toHaveProperty("actor");
  });

  it("sends only the exact review action contract to native", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    mocks.invoke.mockResolvedValue(nativeBundle());
    await reviewRuntimeArtifact({
      artifactId: "artifact-1",
      versionId: "version-1",
      expectedRevision: 1,
      action: "request-changes",
      requestedChanges: ["Clarify the conclusion."]
    });
    expect(mocks.invoke).toHaveBeenCalledWith("artifact_review_action", {
      input: {
        artifactId: "artifact-1",
        versionId: "version-1",
        expectedRevision: 1,
        action: "request-changes",
        requestedChanges: ["Clarify the conclusion."]
      }
    });
    const input = mocks.invoke.mock.calls[0][1].input;
    expect(input).not.toHaveProperty("actor");
    expect(input).not.toHaveProperty("reviewer");
    expect(input).not.toHaveProperty("status");
    expect(input).not.toHaveProperty("time");
    expect(input).not.toHaveProperty("authority");
  });

  it("creates a native-equivalent bounded preview artifact without renderer evidence", async () => {
    setActiveRuntimeDataScope("workspace-preview-create-parity");
    const created = await createRuntimeResponseArtifact({
      threadId: "thread-1",
      messageId: "message-1",
      runId: "run-1",
      title: "Answer",
      content: "Answer",
      citations: [{ sourceId: "forged", title: "Forged", snippet: "Not receipt evidence" } as never]
    });
    expect(created.artifact.revision).toBe(1);
    expect(created.currentVersion.version).toBe(1);
    expect(created.currentVersion.citations).toEqual([]);
    expect(created.currentVersion.content.kind).toBe("inline");
    if (created.currentVersion.content.kind === "inline") {
      expect(created.currentVersion.content.media.byteLength).toBe(6);
      expect(created.currentVersion.content.contentHash).toEqual({
        algorithm: "sha-256",
        value: "b2a3aa602762a782e47a4f8e93bb5ae1b8819d1b92b7e6ceb3ef46a3c7077eb0"
      });
      expect(created.currentVersion.contentHash).toEqual(created.currentVersion.content.contentHash);
    }
  });

  it("rejects empty and oversized initial preview content", async () => {
    setActiveRuntimeDataScope("workspace-preview-create-bounds");
    const input = {
      threadId: "thread-1",
      messageId: "message-1",
      runId: "run-1",
      title: "Answer",
      citations: []
    };
    await expect(createRuntimeResponseArtifact({ ...input, content: "" })).rejects.toThrow(/add some content/i);
    await expect(createRuntimeResponseArtifact({ ...input, content: "x".repeat(65_537) })).rejects.toThrow(/too large/i);
    expect(await listRuntimeThreadArtifacts("thread-1")).toEqual([]);
  });

  it("rejects malformed content and citations before UI consumption", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    const malformedContent = JSON.parse(JSON.stringify(nativeBundle()));
    malformedContent.versions[0].content = { kind: "inline", text: "Answer" };
    malformedContent.currentVersion = malformedContent.versions[0];
    mocks.invoke.mockResolvedValueOnce(malformedContent);
    await expect(createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    })).rejects.toThrow(/malformed/i);

    const malformedCitation = JSON.parse(JSON.stringify(nativeBundle()));
    malformedCitation.versions[0].citations = [{ id: "citation-1", label: "Missing source" }];
    malformedCitation.currentVersion = malformedCitation.versions[0];
    mocks.invoke.mockResolvedValueOnce(malformedCitation);
    await expect(createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    })).rejects.toThrow(/malformed/i);

    for (const review of [
      {
        id: "review-1", status: "requested", requestedByInternalUserId: "user-1",
        versionId: "version-1", requestedAt: "2026-07-11T00:00:00.000Z",
        requestedChanges: ["Should not be present"]
      },
      {
        id: "review-1", status: "changes-requested", requestedByInternalUserId: "user-1",
        versionId: "version-1", requestedAt: "2026-07-11T00:00:00.000Z",
        resolvedAt: "2026-07-11T00:01:00.000Z"
      },
      {
        id: "review-1", status: "approved", requestedByInternalUserId: "user-1",
        versionId: "version-1", requestedAt: "2026-07-11T00:00:00.000Z",
        resolvedAt: "2026-07-11T00:01:00.000Z",
        requestedChanges: ["Should not be present"],
        acceptance: { acceptedByInternalUserId: "user-1", acceptedAt: "2026-07-11T00:01:00.000Z" }
      }
    ]) {
      const invalidShape = JSON.parse(JSON.stringify(nativeBundle()));
      invalidShape.artifact.reviews = [review];
      mocks.invoke.mockResolvedValueOnce(invalidShape);
      await expect(createRuntimeResponseArtifact({
        threadId: "thread-1", messageId: "message-1", runId: "run-1",
        title: "Answer", content: "Answer", citations: []
      })).rejects.toThrow(/malformed/i);
    }
  });

  it("rejects a divergent current version duplicate", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    const divergent = JSON.parse(JSON.stringify(nativeBundle()));
    divergent.currentVersion.content.text = "Divergent text";
    mocks.invoke.mockResolvedValue(divergent);
    await expect(createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    })).rejects.toThrow(/malformed/i);
  });

  it("rejects malformed reviews and reviews linked to a foreign version", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    const invalidStatus = JSON.parse(JSON.stringify(nativeBundle()));
    invalidStatus.artifact.reviews = [{
      id: "review-1", status: "mystery", requestedByInternalUserId: "user-1",
      versionId: "version-1", requestedAt: "2026-07-11T00:00:00.000Z"
    }];
    mocks.invoke.mockResolvedValueOnce(invalidStatus);
    await expect(createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    })).rejects.toThrow(/malformed/i);

    const foreignVersion = JSON.parse(JSON.stringify(nativeBundle()));
    foreignVersion.artifact.reviews = [{
      id: "review-1", status: "requested", requestedByInternalUserId: "user-1",
      versionId: "version-foreign", requestedAt: "2026-07-11T00:00:00.000Z"
    }];
    mocks.invoke.mockResolvedValueOnce(foreignVersion);
    await expect(createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    })).rejects.toThrow(/malformed/i);
  });

  it("appends v2 immutably in preview without inventing sources and enforces CAS", async () => {
    setActiveRuntimeDataScope("workspace-preview-revision");
    const first = await createRuntimeResponseArtifact({
      threadId: "thread-1",
      messageId: "message-1",
      runId: "run-1",
      title: "Answer",
      content: "Version one",
      citations: [{ sourceId: "source-1", title: "Roadmap", snippet: "Evidence" } as never]
    });
    const originalText = first.currentVersion.content.kind === "inline" ? first.currentVersion.content.text : "";
    const second = await appendRuntimeArtifactVersion({
      artifactId: first.artifact.id,
      expectedRevision: first.artifact.revision,
      expectedCurrentVersionId: first.currentVersion.id,
      content: "Version two"
    });
    expect(second.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(second.currentVersion.citations).toEqual([]);
    expect(first.currentVersion.content.kind === "inline" ? first.currentVersion.content.text : "").toBe(originalText);
    await expect(appendRuntimeArtifactVersion({
      artifactId: first.artifact.id,
      expectedRevision: first.artifact.revision,
      expectedCurrentVersionId: first.currentVersion.id,
      content: "Stale edit"
    })).rejects.toThrow(/changed elsewhere/i);
  });

  it("rejects empty and oversized versions before changing preview state", async () => {
    setActiveRuntimeDataScope("workspace-preview-validation");
    const first = await createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Version one", citations: []
    });
    const base = {
      artifactId: first.artifact.id,
      expectedRevision: first.artifact.revision,
      expectedCurrentVersionId: first.currentVersion.id
    };
    await expect(appendRuntimeArtifactVersion({ ...base, content: "" })).rejects.toThrow(/add some content/i);
    await expect(appendRuntimeArtifactVersion({ ...base, content: "x".repeat(65_537) })).rejects.toThrow(/too large/i);
    expect((await listRuntimeThreadArtifacts("thread-1"))[0].versions).toHaveLength(1);
  });

  it("isolates preview artifact revisions by active workspace", async () => {
    setActiveRuntimeDataScope("workspace-preview-a");
    const first = await createRuntimeResponseArtifact({
      threadId: "thread-shared", messageId: "message-a", runId: "run-a",
      title: "A", content: "Workspace A", citations: []
    });
    setActiveRuntimeDataScope("workspace-preview-b");
    expect(await listRuntimeThreadArtifacts("thread-shared")).toEqual([]);
    await expect(appendRuntimeArtifactVersion({
      artifactId: first.artifact.id,
      expectedRevision: first.artifact.revision,
      expectedCurrentVersionId: first.currentVersion.id,
      content: "Cross-workspace edit"
    })).rejects.toThrow(/no longer available/i);
    setActiveRuntimeDataScope("workspace-preview-a");
    expect(await listRuntimeThreadArtifacts("thread-shared")).toHaveLength(1);
  });

  it("mirrors request-review and accept transitions in preview", async () => {
    setActiveRuntimeDataScope("workspace-preview-review-accept");
    const draft = await createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    });
    const inReview = await reviewRuntimeArtifact({
      artifactId: draft.artifact.id,
      versionId: draft.currentVersion.id,
      expectedRevision: draft.artifact.revision,
      action: "request-review"
    });
    expect(inReview.artifact.status).toBe("in-review");
    expect(inReview.artifact.revision).toBe(2);
    expect(inReview.artifact.reviews[0]).toEqual(expect.objectContaining({
      status: "requested",
      versionId: draft.currentVersion.id
    }));

    const accepted = await reviewRuntimeArtifact({
      artifactId: inReview.artifact.id,
      versionId: inReview.currentVersion.id,
      expectedRevision: inReview.artifact.revision,
      action: "accept"
    });
    expect(accepted.artifact.status).toBe("accepted");
    expect(accepted.artifact.reviews[0]).toEqual(expect.objectContaining({
      status: "approved",
      acceptance: expect.objectContaining({ acceptedByInternalUserId: "preview-user" })
    }));
  });

  it("mirrors requested changes and preserves review history when a new draft version is appended", async () => {
    setActiveRuntimeDataScope("workspace-preview-review-changes");
    const draft = await createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    });
    const inReview = await reviewRuntimeArtifact({
      artifactId: draft.artifact.id, versionId: draft.currentVersion.id,
      expectedRevision: draft.artifact.revision, action: "request-review"
    });
    const changes = await reviewRuntimeArtifact({
      artifactId: inReview.artifact.id, versionId: inReview.currentVersion.id,
      expectedRevision: inReview.artifact.revision, action: "request-changes",
      requestedChanges: ["Clarify the conclusion."]
    });
    expect(changes.artifact.status).toBe("changes-requested");
    expect(changes.artifact.reviews[0]).toEqual(expect.objectContaining({
      status: "changes-requested",
      requestedChanges: ["Clarify the conclusion."]
    }));

    const revised = await appendRuntimeArtifactVersion({
      artifactId: changes.artifact.id,
      expectedRevision: changes.artifact.revision,
      expectedCurrentVersionId: changes.currentVersion.id,
      content: "Revised answer"
    });
    expect(revised.artifact.status).toBe("draft");
    expect(revised.artifact.reviews).toEqual(changes.artifact.reviews);
    expect(revised.versions).toHaveLength(2);
  });

  it("rejects stale revisions and review actions against an old version", async () => {
    setActiveRuntimeDataScope("workspace-preview-review-stale");
    const draft = await createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Answer", content: "Answer", citations: []
    });
    const inReview = await reviewRuntimeArtifact({
      artifactId: draft.artifact.id, versionId: draft.currentVersion.id,
      expectedRevision: draft.artifact.revision, action: "request-review"
    });
    await expect(reviewRuntimeArtifact({
      artifactId: inReview.artifact.id, versionId: inReview.currentVersion.id,
      expectedRevision: draft.artifact.revision, action: "accept"
    })).rejects.toThrow(/changed elsewhere/i);
    await expect(appendRuntimeArtifactVersion({
      artifactId: inReview.artifact.id,
      expectedRevision: inReview.artifact.revision,
      expectedCurrentVersionId: inReview.currentVersion.id,
      content: "New draft"
    })).rejects.toThrow("Resolve private review before editing.");
    const changes = await reviewRuntimeArtifact({
      artifactId: inReview.artifact.id,
      versionId: inReview.currentVersion.id,
      expectedRevision: inReview.artifact.revision,
      action: "request-changes",
      requestedChanges: ["Revise this draft."]
    });
    await expect(reviewRuntimeArtifact({
      artifactId: changes.artifact.id,
      versionId: changes.currentVersion.id,
      expectedRevision: changes.artifact.revision,
      action: "request-review"
    })).rejects.toThrow(/not ready to request review/i);
    const revised = await appendRuntimeArtifactVersion({
      artifactId: changes.artifact.id,
      expectedRevision: changes.artifact.revision,
      expectedCurrentVersionId: changes.currentVersion.id,
      content: "New draft"
    });
    await expect(reviewRuntimeArtifact({
      artifactId: revised.artifact.id,
      versionId: inReview.currentVersion.id,
      expectedRevision: revised.artifact.revision,
      action: "request-review"
    })).rejects.toThrow(/changed elsewhere/i);
  });

  it("searches preview artifacts by title and current content with a bounded result", async () => {
    setActiveRuntimeDataScope("workspace-preview-search");
    const alpha = await createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-a", runId: "run-a",
      title: "Alpha report", content: "Original notes", citations: []
    });
    await appendRuntimeArtifactVersion({
      artifactId: alpha.artifact.id,
      expectedRevision: alpha.artifact.revision,
      expectedCurrentVersionId: alpha.currentVersion.id,
      content: "Current launch forecast"
    });
    await createRuntimeResponseArtifact({
      threadId: "thread-2", messageId: "message-b", runId: "run-b",
      title: "Beta report", content: "Different work", citations: []
    });
    const title = await searchRuntimeArtifacts({ query: "alpha", limit: 1 });
    expect(title).toHaveLength(1);
    expect(title[0].matchedOn).toContain("title");
    const content = await searchRuntimeArtifacts({ query: "forecast" });
    expect(content[0].matchedOn).toContain("content");
    expect(await searchRuntimeArtifacts({ query: "original notes" })).toEqual([]);
  });

  it("exports one exact immutable historical preview version", async () => {
    setActiveRuntimeDataScope("workspace-preview-export");
    const first = await createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Report", content: "Version one", citations: []
    });
    const second = await appendRuntimeArtifactVersion({
      artifactId: first.artifact.id,
      expectedRevision: first.artifact.revision,
      expectedCurrentVersionId: first.currentVersion.id,
      content: "Version two"
    });
    const exported = await exportRuntimeArtifact(second.artifact.id, first.currentVersion.id);
    expect(exported.versionId).toBe(first.currentVersion.id);
    expect(exported.content.kind === "inline" ? exported.content.text : "").toBe("Version one");
    expect(exported).not.toHaveProperty("sourceMessageId");
    expect(exported).not.toHaveProperty("producingRunId");
  });

  it("isolates preview search and export by active workspace", async () => {
    setActiveRuntimeDataScope("workspace-search-a");
    const created = await createRuntimeResponseArtifact({
      threadId: "thread-1", messageId: "message-1", runId: "run-1",
      title: "Private alpha", content: "Workspace A", citations: []
    });
    setActiveRuntimeDataScope("workspace-search-b");
    expect(await searchRuntimeArtifacts({ query: "alpha" })).toEqual([]);
    await expect(exportRuntimeArtifact(created.artifact.id, created.currentVersion.id))
      .rejects.toThrow(/no longer available/i);
  });

  it("sends exact native search/export requests and rejects malformed or cross-workspace results", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    const bundle = nativeBundle();
    mocks.invoke.mockResolvedValueOnce([{
      artifact: bundle.artifact,
      currentVersion: bundle.currentVersion,
      matchedOn: ["title"]
    }]);
    await searchRuntimeArtifacts({ query: " report ", limit: 500 });
    expect(mocks.invoke).toHaveBeenLastCalledWith("artifact_search", {
      input: { query: "report", limit: 100 }
    });

    mocks.invoke.mockResolvedValueOnce([{ artifact: { ...bundle.artifact, workspaceId: "other" }, currentVersion: bundle.currentVersion, matchedOn: [] }]);
    await expect(searchRuntimeArtifacts()).rejects.toThrow(/cross-workspace/i);

    mocks.invoke.mockResolvedValueOnce({
      artifactId: bundle.artifact.id,
      versionId: bundle.currentVersion.id,
      title: bundle.artifact.title,
      kind: bundle.artifact.kind,
      exportedAt: "2026-07-11T00:00:00.000Z",
      content: bundle.currentVersion.content,
      citations: [], inputs: [], decisions: [], lineage: []
    });
    await exportRuntimeArtifact(bundle.artifact.id, bundle.currentVersion.id);
    expect(mocks.invoke).toHaveBeenLastCalledWith("artifact_export", {
      input: {
        artifactId: bundle.artifact.id,
        versionId: bundle.currentVersion.id
      }
    });

    mocks.invoke.mockResolvedValueOnce({
      artifactId: bundle.artifact.id,
      versionId: bundle.currentVersion.id,
      title: bundle.artifact.title,
      kind: bundle.artifact.kind,
      exportedAt: "2026-07-11T00:00:00.000Z",
      content: bundle.currentVersion.content,
      citations: [], inputs: [], decisions: [], lineage: [],
      sourcePath: "C:\\private\\notes.md"
    });
    await expect(exportRuntimeArtifact(bundle.artifact.id, bundle.currentVersion.id))
      .rejects.toThrow(/malformed/i);
  });

  it("rejects native search and export responses after the active workspace changes", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-native");
    const bundle = nativeBundle();
    let resolveSearch!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise((resolve) => { resolveSearch = resolve; }));
    const search = searchRuntimeArtifacts({ query: "report" });
    setActiveRuntimeDataScope("workspace-other");
    resolveSearch([{ artifact: bundle.artifact, currentVersion: bundle.currentVersion, matchedOn: ["title"] }]);
    await expect(search).rejects.toThrow(/active workspace changed/i);

    setActiveRuntimeDataScope("workspace-native");
    let resolveExport!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise((resolve) => { resolveExport = resolve; }));
    const exported = exportRuntimeArtifact(bundle.artifact.id, bundle.currentVersion.id);
    setActiveRuntimeDataScope("workspace-other");
    resolveExport({
      artifactId: bundle.artifact.id,
      versionId: bundle.currentVersion.id,
      title: bundle.artifact.title,
      kind: bundle.artifact.kind,
      exportedAt: "2026-07-11T00:00:00.000Z",
      content: bundle.currentVersion.content,
      citations: [], inputs: [], decisions: [], lineage: []
    });
    await expect(exported).rejects.toThrow(/active workspace changed/i);
  });
});
