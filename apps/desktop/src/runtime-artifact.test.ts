import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";
import {
  appendRuntimeArtifactVersion,
  createRuntimeResponseArtifact,
  listRuntimeThreadArtifacts,
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
      revision: 0,
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
      expectedRevision: 0,
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

  it("appends v2 immutably in preview, retains sources, and enforces CAS", async () => {
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
    expect(second.currentVersion.citations).toEqual(first.currentVersion.citations);
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
});
