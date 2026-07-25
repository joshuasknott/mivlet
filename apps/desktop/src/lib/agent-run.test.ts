import { describe, expect, it } from "vitest";
import type { AccountWorkspaceStatus, KnowledgeSource, MemoryRecord } from "@fable/protocol";
import {
  buildAgentRequest,
  buildContinuationMessages,
  buildContextPrefixForRun,
  DEFAULT_PERMISSION_LABEL,
  findApprovalJargon,
  knowledgeScopeForRun,
  PERMISSION_PROFILES,
  permissionLabelFor,
  permissionModeFor,
  privateRunAudience,
  recordsVisibleToRunAudience,
  resolveSelectedModel,
  selectMemoryForRun,
  sourceAllowedByProjectConnections,
  withPreviewPrivateAuthority,
  workspaceSharedRunAudience
} from "./agent-run";

const memory = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "m1",
  kind: "fact",
  title: "User name",
  value: "Josh",
  source: "approved",
  freshness: "now",
  approved: true,
  pinned: true,
  ...over
});

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id: "s1",
  title: "Launch notes",
  kind: "document",
  connectorId: "local-files",
  provenance: "import",
  freshness: "today",
  pinned: true,
  ...over
});

const accountStatus = (over: Partial<AccountWorkspaceStatus> = {}): AccountWorkspaceStatus => ({
  configured: true,
  state: "ready",
  message: "Workspace ready.",
  accountBound: true,
  workspaces: [{
    fableWorkspaceId: "workspace-hosted",
    localWorkspaceId: "workspace-local",
    name: "Fable",
    workspaceStatus: "active",
    workspaceRevision: 1,
    policyRevision: 1,
    memberId: "member-active",
    role: "owner",
    membershipStatus: "active",
    membershipRevision: 1,
    updatedAt: "2026-07-11T00:00:00.000Z"
  }],
  activeWorkspace: {
    localWorkspaceId: "workspace-local",
    fableWorkspaceId: "workspace-hosted",
    name: "Fable",
    source: "hosted"
  },
  activeContextOwner: {
    internalUserId: "user-active",
    memberId: "member-active"
  },
  devices: [],
  ...over
});

describe("run context audience", () => {
  it("derives the private audience from the exact active hosted member", () => {
    expect(privateRunAudience(accountStatus())).toEqual({
      authority: "local",
      visibility: "member-private",
      actingMemberId: "member-active"
    });
  });

  it("fails closed instead of using a mismatched or legacy placeholder member", () => {
    expect(() => privateRunAudience(accountStatus({
      activeWorkspace: {
        localWorkspaceId: "other-local",
        fableWorkspaceId: "workspace-hosted",
        name: "Other",
        source: "hosted"
      }
    }))).toThrow(/could not confirm who can use this context/i);
    expect(() => privateRunAudience(accountStatus({
      activeWorkspace: {
        localWorkspaceId: "workspace-local",
        name: "Legacy",
        source: "legacy-default"
      },
      activeContextOwner: undefined
    }))).toThrow(/could not confirm who can use this context/i);
  });

  it("uses the authenticated internal user for a legacy-default local workspace", () => {
    expect(privateRunAudience(accountStatus({
      workspaces: [],
      activeWorkspace: {
        localWorkspaceId: "workspace-local",
        name: "Local workspace",
        source: "legacy-default"
      },
      activeContextOwner: { internalUserId: "user-local" }
    }))).toEqual({
      authority: "local",
      visibility: "member-private",
      actingInternalUserId: "user-local"
    });
  });

  it("assigns explicit preview ownership without mutating fixture records", () => {
    const preview = privateRunAudience(accountStatus({
      configured: false,
      activeWorkspace: {
        localWorkspaceId: "workspace-local",
        fableWorkspaceId: "workspace-hosted",
        name: "Preview",
        source: "legacy-default"
      },
      activeContextOwner: { internalUserId: "preview-user" }
    }));
    const original = memory({ authorityScope: undefined });
    const [owned] = withPreviewPrivateAuthority([original], preview);
    expect(original.authorityScope).toBeUndefined();
    expect(owned.authorityScope).toEqual({
      authority: "local",
      visibility: "member-private",
      ownerInternalUserId: "preview-user"
    });
  });

  it("excludes private inputs from a synthetic shared audience via the central filter contract", () => {
    const sharedAudience = workspaceSharedRunAudience("member-active");
    const records = recordsVisibleToRunAudience([
      memory({
        id: "private",
        authorityScope: {
          authority: "local",
          visibility: "member-private",
          ownerMemberId: "member-active" as never
        }
      }),
      memory({
        id: "shared",
        authorityScope: { authority: "convex", visibility: "workspace-shared" }
      }),
      memory({ id: "legacy", authorityScope: undefined })
    ], sharedAudience);
    expect(records.map((record) => record.id)).toEqual(["shared"]);
  });
});

describe("buildContextPrefixForRun", () => {
  it("builds a prefix from pinned trusted memory + a pinned source", () => {
    const prefix = buildContextPrefixForRun({
      memoryRecords: [memory()],
      knowledgeSources: [
        source({ trust: "trusted", contentPreview: "ship Friday" })
      ],
      pinnedSourceIds: ["s1"],
      memoryDisabled: false
    });
    expect(prefix).toContain("Trusted memory");
    expect(prefix).toContain("Josh");
    expect(prefix).toContain("Trusted knowledge");
    expect(prefix).toContain("ship Friday");
  });

  it("is empty when nothing is pinned", () => {
    expect(
      buildContextPrefixForRun({
        memoryRecords: [memory({ pinned: false })],
        knowledgeSources: [],
        pinnedSourceIds: [],
        memoryDisabled: false
      })
    ).toBe("");
  });

  it("omits memory entirely when memory is disabled", () => {
    // Even with a pinned trusted record, disabled memory yields no memory text.
    const prefix = buildContextPrefixForRun({
      memoryRecords: [memory()],
      knowledgeSources: [],
      pinnedSourceIds: [],
      memoryDisabled: true
    });
    expect(prefix).toBe("");
  });

  it("omits memory when disabled even if a source is still pinned", () => {
    const prefix = buildContextPrefixForRun({
      memoryRecords: [memory()],
      knowledgeSources: [
        source({ trust: "trusted", contentPreview: "kept" })
      ],
      pinnedSourceIds: ["s1"],
      memoryDisabled: true
    });
    expect(prefix).not.toContain("Trusted memory");
    expect(prefix).toContain("kept");
  });

  it("excludes sources that are not in the pinned set", () => {
    const prefix = buildContextPrefixForRun({
      memoryRecords: [],
      knowledgeSources: [
        source({ id: "pinned", trust: "trusted", contentPreview: "in" }),
        source({ id: "other", trust: "trusted", contentPreview: "out" })
      ],
      pinnedSourceIds: ["pinned"],
      memoryDisabled: false
    });
    expect(prefix).toContain("in");
    expect(prefix).not.toContain("out");
  });
});

describe("selectMemoryForRun", () => {
  it("keeps workspace-global memory and includes only the exact project", () => {
    const workspace = memory({ id: "workspace", scope: { level: "global" } });
    const exact = memory({ id: "exact", scope: { level: "project", projectId: "project-a" } });
    const foreign = memory({ id: "foreign", scope: { level: "project", projectId: "project-b" } });
    const unscopedProjectInput = memory({ id: "unscoped", scope: undefined });

    expect(selectMemoryForRun([workspace], {
      projectId: "project-a",
      projectMemoryRecords: [exact, foreign, unscopedProjectInput]
    }).map((record) => record.id)).toEqual(["workspace", "exact"]);
  });

  it("does not admit project memory for a standalone run", () => {
    const workspace = memory({ id: "workspace", scope: undefined });
    const legacyScopedWorkspace = memory({
      id: "legacy-scoped-workspace",
      scope: { level: "project", projectId: "project-a" }
    });
    const project = memory({ id: "project", scope: { level: "project", projectId: "project-a" } });

    expect(selectMemoryForRun([workspace, legacyScopedWorkspace], {
      projectId: null,
      projectMemoryRecords: [project]
    }).map((record) => record.id)).toEqual(["workspace"]);
  });

  it("excludes disabled and forgotten records from both inputs", () => {
    const projectScope = { level: "project" as const, projectId: "project-a" };
    expect(selectMemoryForRun([
      memory({ id: "workspace-live" }),
      memory({ id: "workspace-disabled", disabled: true }),
      memory({ id: "workspace-forgotten", forgottenAt: "2026-07-11T00:00:00.000Z" })
    ], {
      projectId: "project-a",
      projectMemoryRecords: [
        memory({ id: "project-live", scope: projectScope }),
        memory({ id: "project-disabled", scope: projectScope, disabled: true }),
        memory({ id: "project-forgotten", scope: projectScope, forgottenAt: "2026-07-11T00:00:00.000Z" })
      ]
    }).map((record) => record.id)).toEqual(["workspace-live", "project-live"]);
  });

  it("does not let project input replace workspace authority on an id collision", () => {
    const workspace = memory({ id: "shared", value: "workspace value" });
    const project = memory({
      id: "shared",
      value: "project value",
      scope: { level: "project", projectId: "project-a" }
    });

    expect(selectMemoryForRun([workspace], {
      projectId: "project-a",
      projectMemoryRecords: [project]
    })).toEqual([workspace]);
  });

  it("keeps the existing workspace-only call path", () => {
    const workspace = memory({ id: "workspace" });
    const scoped = memory({ id: "scoped", scope: { level: "project", projectId: "project-a" } });

    expect(selectMemoryForRun([workspace, scoped])).toEqual([workspace, scoped]);
  });
});

describe("knowledgeScopeForRun", () => {
  it("uses the explicit durable project rather than inferred fixture membership", () => {
    expect(knowledgeScopeForRun("thread-1", { projectId: "project-durable" })).toEqual({
      level: "thread",
      threadId: "thread-1",
      projectId: "project-durable"
    });
    expect(knowledgeScopeForRun(undefined, { projectId: "project-durable" })).toEqual({
      level: "project",
      projectId: "project-durable"
    });
  });

  it("keeps the existing one-argument workspace call path", () => {
    expect(knowledgeScopeForRun(undefined)).toEqual({ level: "global" });
    expect(knowledgeScopeForRun("thread-1")).toEqual({
      level: "thread",
      threadId: "thread-1",
      projectId: "workspace"
    });
  });
});

describe("sourceAllowedByProjectConnections", () => {
  it("filters connector sources by exact Project selection before retrieval", () => {
    const context = {
      projectId: "project-a",
      allowedConnectionIds: ["connection-a"]
    };
    expect(sourceAllowedByProjectConnections(source(), context)).toBe(true);
    expect(sourceAllowedByProjectConnections(source({
      connectorId: "github",
      connectionId: "connection-a"
    }), context)).toBe(true);
    expect(sourceAllowedByProjectConnections(source({
      connectorId: "github",
      connectionId: "connection-b"
    }), context)).toBe(false);
    expect(sourceAllowedByProjectConnections(source({
      connectorId: "github",
      connectionId: undefined
    }), context)).toBe(false);
  });

  it("keeps standalone workspace retrieval unchanged", () => {
    expect(sourceAllowedByProjectConnections(source({
      connectorId: "github",
      connectionId: "connection-b"
    }))).toBe(true);
  });
});

describe("buildAgentRequest", () => {
  it("shapes the model/messages into a provider-neutral AgentRunRequest", () => {
    const request = buildAgentRequest({
      model: "gpt-5",
      prompt: "Summarize the project",
      maxTokens: 2048
    });
    expect(request).toEqual({
      model: "gpt-5",
      messages: [{ role: "user", content: "Summarize the project" }],
      tools: [],
      maxTokens: 2048
    });
  });

  it("uses the selected model id rather than a hardcoded label", () => {
    const request = buildAgentRequest({
      model: "claude-sonnet-4",
      prompt: "hello",
      maxTokens: 1024
    });
    expect(request.model).toBe("claude-sonnet-4");
  });
});

describe("buildContinuationMessages", () => {
  it("uses only terminal user, assistant, and completed tool-result records", () => {
    const messages = buildContinuationMessages([
      { message: { kind: "approval", sequence: 1, detail: { phase: "request", approvalRequestId: "approval-1" } }, currentRevision: { state: "terminal", content: "Permit this" } },
      { message: { kind: "user", sequence: 2 }, currentRevision: { state: "terminal", content: "Do the work" } },
      { message: { kind: "tool", sequence: 3, detail: { phase: "call", toolCallId: "call-1", toolName: "write-file" } }, currentRevision: { state: "terminal", content: "write-file" } },
      { message: { kind: "tool", sequence: 4, detail: { phase: "result", toolCallId: "call-1", toolName: "write-file", outcome: "succeeded" } }, currentRevision: { state: "terminal", content: "written" } },
      { message: { kind: "error", sequence: 5, detail: { code: "offline", retryable: true } }, currentRevision: { state: "terminal", content: "offline" } },
      { message: { kind: "assistant", sequence: 6 }, currentRevision: { state: "streaming", content: "partial" } }
    ] as never);

    expect(messages).toEqual([
      { role: "user", content: "Do the work" },
      { role: "tool", content: "written", toolCallId: "call-1", toolName: "write-file" }
    ]);
  });
});

describe("approval preset mapping", () => {
  it("exposes three primary choices plus Custom and defaults to Ask Me", () => {
    expect(PERMISSION_PROFILES.map((profile) => profile.label)).toEqual([
      "Read Only",
      "Ask Me",
      "Work Freely",
      "Custom"
    ]);
    expect(DEFAULT_PERMISSION_LABEL).toBe("Ask Me");
  });

  it("maps the plain labels to the existing modes", () => {
    expect(permissionModeFor("Read Only")).toBe("read-only");
    expect(permissionModeFor("Ask Me")).toBe("trusted-scope");
    expect(permissionModeFor("Work Freely")).toBe("full-access");
    expect(permissionLabelFor("full-access")).toBe("Work Freely");
    expect(permissionLabelFor("trusted-scope")).toBe("Ask Me");
    expect(permissionLabelFor("read-only")).toBe("Read Only");
  });

  it("keeps visible preset copy free of internal jargon", () => {
    for (const profile of PERMISSION_PROFILES) {
      expect(findApprovalJargon(`${profile.label} ${profile.description}`)).toEqual([]);
    }
  });
});

describe("resolveSelectedModel", () => {
  const models = [
    { id: "gpt-5", label: "GPT-5", available: true },
    { id: "gpt-4.1", label: "GPT-4.1", available: false },
    { id: "o3", label: "o3", available: true }
  ];

  it("keeps the persisted model when it is still available", () => {
    expect(resolveSelectedModel(models, "o3")).toBe("o3");
  });

  it("falls back to the first available when the persisted one is gone", () => {
    expect(resolveSelectedModel(models, "old-model")).toBe("gpt-5");
  });

  it("falls back to the first available when nothing was persisted", () => {
    expect(resolveSelectedModel(models, "")).toBe("gpt-5");
  });

  it("returns empty string when no model is available", () => {
    expect(
      resolveSelectedModel(
        [{ id: "x", label: "X", available: false }],
        ""
      )
    ).toBe("");
  });
});
