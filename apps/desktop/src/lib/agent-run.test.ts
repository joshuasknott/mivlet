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
  sourceAllowedByConnections,
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
        name: "Unbound",
        source: "unbound"
      },
      activeContextOwner: undefined
    }))).toThrow(/could not confirm who can use this context/i);
  });

  it("fails closed for an unbound workspace even when an account owner is present", () => {
    expect(() => privateRunAudience(accountStatus({
      workspaces: [],
      activeWorkspace: {
        localWorkspaceId: "",
        name: "No workspace selected",
        source: "unbound"
      },
      activeContextOwner: { internalUserId: "user-local" }
    }))).toThrow(/could not confirm who can use this context/i);
  });

  it("assigns explicit preview ownership without mutating fixture records", () => {
    const preview = privateRunAudience(accountStatus({
      configured: false,
      activeWorkspace: {
        localWorkspaceId: "workspace-local",
        fableWorkspaceId: "workspace-hosted",
        name: "Preview",
        source: "preview"
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

  it("assigns native-confirmed ownership to a local-only workspace", () => {
    expect(privateRunAudience(accountStatus({
      configured: false,
      workspaces: [],
      activeWorkspace: {
        localWorkspaceId: "default",
        name: "On this PC",
        source: "local"
      },
      activeContextOwner: { internalUserId: "local-device", memberId: "local-member" }
    }))).toEqual({
      authority: "local",
      visibility: "member-private",
      actingMemberId: "local-member"
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
  it("keeps only live workspace memory", () => {
    expect(selectMemoryForRun([
      memory({ id: "live" }),
      memory({ id: "disabled", disabled: true }),
      memory({ id: "forgotten", forgottenAt: "2026-07-11T00:00:00.000Z" })
    ]).map((record) => record.id)).toEqual(["live"]);
  });
});

describe("knowledgeScopeForRun", () => {
  it("uses the active conversation or the global workspace", () => {
    expect(knowledgeScopeForRun(undefined)).toEqual({ level: "global" });
    expect(knowledgeScopeForRun("thread-1")).toEqual({
      level: "thread",
      threadId: "thread-1"
    });
  });
});

describe("sourceAllowedByConnections", () => {
  it("applies an exact optional Connection allowlist before retrieval", () => {
    const context = { allowedConnectionIds: ["connection-a"] };
    expect(sourceAllowedByConnections(source(), context)).toBe(true);
    expect(sourceAllowedByConnections(source({
      connectorId: "github",
      connectionId: "connection-a"
    }), context)).toBe(true);
    expect(sourceAllowedByConnections(source({
      connectorId: "github",
      connectionId: "connection-b"
    }), context)).toBe(false);
    expect(sourceAllowedByConnections(source({
      connectorId: "github",
      connectionId: undefined
    }), context)).toBe(false);
  });

  it("does not narrow retrieval when no allowlist is configured", () => {
    expect(sourceAllowedByConnections(source({
      connectorId: "github",
      connectionId: "connection-b"
    }))).toBe(true);
  });
});

describe("buildAgentRequest", () => {
  it("shapes the model/messages into a provider-neutral AgentTurnRequest", () => {
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
