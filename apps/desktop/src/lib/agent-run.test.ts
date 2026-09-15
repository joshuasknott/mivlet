import { describe, expect, it } from "vitest";
import type { AccountWorkspaceStatus, KnowledgeSource, MemoryRecord } from "@mivlet/protocol";
import {
  buildAgentRequest,
  buildContinuationMessages,
  continuationMessagesForModel,
  buildInterruptedAttemptCheckpoint,
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
  withPreviewPrivateAuthority
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
  workspaces: [],
  activeWorkspace: {
    localWorkspaceId: "default",
    name: "On this PC",
    source: "local"
  },
  activeContextOwner: {
    internalUserId: "local-user",
    memberId: "local-member"
  },
  devices: [],
  ...over
});

describe("run context audience", () => {
  it("derives the private audience from the installation-local owner", () => {
    expect(privateRunAudience(accountStatus())).toEqual({
      authority: "local",
      visibility: "member-private",
      actingMemberId: "local-member"
    });
  });

  it("fails closed for non-local or unbound workspace assertions", () => {
    expect(() => privateRunAudience(accountStatus({
      activeWorkspace: {
        localWorkspaceId: "hosted-local",
        fableWorkspaceId: "workspace-hosted",
        name: "Hosted",
        source: "hosted"
      }
    }))).toThrow(/installation's private context owner/i);
    expect(() => privateRunAudience(accountStatus({
      activeWorkspace: {
        localWorkspaceId: "",
        name: "Unbound",
        source: "unbound"
      },
      activeContextOwner: undefined
    }))).toThrow(/installation's private context owner/i);
  });

  it("fails closed when local ownership is missing", () => {
    expect(() => privateRunAudience(accountStatus({
      activeWorkspace: {
        localWorkspaceId: "default",
        name: "On this PC",
        source: "local"
      },
      activeContextOwner: undefined
    }))).toThrow(/installation's private context owner/i);
  });

  it("assigns explicit local ownership without mutating fixture records", () => {
    const audience = privateRunAudience(accountStatus({
      activeContextOwner: { internalUserId: "preview-user" }
    }));
    const original = memory({ authorityScope: undefined });
    const [owned] = withPreviewPrivateAuthority([original], audience);
    expect(original.authorityScope).toBeUndefined();
    expect(owned.authorityScope).toEqual({
      authority: "local",
      visibility: "member-private",
      ownerInternalUserId: "preview-user"
    });
  });

  it("filters context to the exact installation-local owner", () => {
    const audience = privateRunAudience(accountStatus());
    const records = recordsVisibleToRunAudience([
      memory({
        id: "matching",
        authorityScope: {
          authority: "local",
          visibility: "member-private",
          ownerMemberId: "local-member" as never
        }
      }),
      memory({
        id: "other",
        authorityScope: {
          authority: "local",
          visibility: "member-private",
          ownerMemberId: "other-member" as never
        }
      }),
      memory({ id: "legacy", authorityScope: undefined })
    ], audience);
    expect(records.map((record) => record.id)).toEqual(["matching"]);
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
  it("keeps agent instructions out of the user's message", () => {
    const request = buildAgentRequest({ model: "test", prompt: "Plan my week", instructions: "  Keep priorities clear.  " });
    expect(request.messages).toEqual([
      { role: "system", content: "Keep priorities clear." },
      { role: "user", content: "Plan my week" },
    ]);
    expect(buildAgentRequest({ model: "test", prompt: "Hello", instructions: "  " }).messages).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });
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

  it("attaches transient images only to the current user message", () => {
    const image = {
      id: "image-1",
      name: "diagram.png",
      mediaType: "image/png" as const,
      sizeBytes: 68,
      width: 1,
      height: 1,
      dataUrl: "data:image/png;base64,transient-pixels"
    };
    const request = buildAgentRequest({
      model: "codex-model",
      prompt: "Describe this",
      instructions: "Be concise.",
      images: [image]
    });
    expect(request.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Describe this", images: [image] }
    ]);
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
  it("retains published image references for later edits without old authority fields", () => {
    const receipt = { kind: "computer-artifact", version: 1, id: `artifact-${"a".repeat(64)}`, computerId: `local-${"b".repeat(24)}`, title: "Image", relativePath: "image.png", mimeType: "image/png", sizeBytes: 128, createdAt: "2026-09-07T12:00:00Z" };
    const messages = continuationMessagesForModel([{ role: "user", content: "Make an image" }, { role: "tool", content: JSON.stringify({ ...receipt, permitId: "old-permit", generation: 4 }) }, { role: "assistant", content: "Image ready" }]);
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toContain(receipt.id);
    expect(messages[1].content).toContain("untrusted metadata");
    expect(messages[1].content).not.toMatch(/permitId|old-permit|generation/);
    expect(messages[2]).toEqual({ role: "assistant", content: "Image ready" });
    expect(continuationMessagesForModel([{ role: "tool", content: JSON.stringify({ ...receipt, relativePath: "../secret.png" }) }])).toEqual([]);
  });
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

describe("buildInterruptedAttemptCheckpoint", () => {
  it("keeps bounded successful progress and marks incomplete work uncertain", () => {
    const checkpoint = buildInterruptedAttemptCheckpoint({
      id: "attempt-1", providerId: "openai", model: "gpt-5", status: "interrupted",
      transcript: "Drafted the report and was checking the export.",
      exchanges: [
        { role: "user", content: "Create and verify the report" },
        { role: "tool", toolName: "write-file", toolCallId: "call-1", content: "report.docx written", ok: true },
        { role: "tool", toolName: "run-shell", toolCallId: "call-2", content: "Command may still be running", ok: false },
        { role: "tool", toolName: "local-browser-observe", toolCallId: "call-3", content: '{"observationId":"fresh-secret"}', ok: true }
      ],
      turn: 2, pendingApprovalIds: ["approval-secret"], recoverable: true, retryCount: 0,
      createdAt: "2026-09-07T10:00:00Z", updatedAt: "2026-09-07T10:01:00Z"
    });
    expect(checkpoint).toContain("Committed task intent:\nCreate and verify the report");
    expect(checkpoint).toContain("write-file: report.docx written");
    expect(checkpoint).toContain("1 tool result was failed or lacked confirmed success");
    expect(checkpoint).toContain("Do not treat it as completed or as justification to resubmit");
    expect(checkpoint).not.toContain("approval-secret");
    expect(checkpoint).not.toContain("observationId");
    expect(checkpoint.length).toBeLessThanOrEqual(12_000);
  });

  it("omits secret-shaped and authority-bearing lines instead of forwarding them", () => {
    const checkpoint = buildInterruptedAttemptCheckpoint({
      id: "attempt-2", providerId: "openai", model: "gpt-5", status: "failed",
      transcript: "Safe progress\nAuthorization: Bearer private-value\napproval permit approval-1",
      exchanges: [
        { role: "user", content: "Finish the safe task\nCookie: private-cookie" },
        { role: "tool", toolName: "read-file", content: "public result\naccess_token=private", ok: true }
      ],
      turn: 1, pendingApprovalIds: [], recoverable: true, retryCount: 0,
      createdAt: "2026-09-07T10:00:00Z", updatedAt: "2026-09-07T10:01:00Z"
    });
    expect(checkpoint).toContain("Finish the safe task");
    expect(checkpoint).toContain("read-file: public result");
    expect(checkpoint).toContain("Safe progress");
    expect(checkpoint).not.toMatch(/private-value|private-cookie|access_token|approval-1/);
  });

  it("recursively removes fresh authority fields while retaining useful artifact identity", () => {
    const checkpoint = buildInterruptedAttemptCheckpoint({
      id: "attempt-json", providerId: "openai", model: "gpt-5", status: "interrupted",
      transcript: "Created the artifact.",
      exchanges: [
        { role: "user", content: "Create the report" },
        {
          role: "tool", toolName: "create-artifact", ok: true,
          content: JSON.stringify({
            artifactId: "artifact-report-1",
            result: { title: "Quarterly report", generation: 14, requestId: "request-secret" },
            approval: { permitId: "permit-secret" }
          })
        }
      ],
      turn: 1, pendingApprovalIds: [], recoverable: true, retryCount: 0,
      createdAt: "2026-09-07T10:00:00Z", updatedAt: "2026-09-07T10:01:00Z"
    });
    expect(checkpoint).toContain('"artifactId":"artifact-report-1"');
    expect(checkpoint).toContain('"title":"Quarterly report"');
    expect(checkpoint).not.toMatch(/generation|request-secret|permit-secret|"approval"/);
  });

  it("keeps uncertainty ahead of bounded large successful results", () => {
    const checkpoint = buildInterruptedAttemptCheckpoint({
      id: "attempt-large", providerId: "openai", model: "gpt-5", status: "interrupted",
      transcript: "x".repeat(20_000),
      exchanges: [
        { role: "user", content: "y".repeat(20_000) },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: "tool" as const,
          toolName: `read-${index}`,
          content: "z".repeat(4_000),
          ok: true
        })),
        { role: "tool", toolName: "write-file", content: "unknown", ok: false }
      ],
      turn: 1, pendingApprovalIds: [], recoverable: true, retryCount: 0,
      createdAt: "2026-09-07T10:00:00Z", updatedAt: "2026-09-07T10:01:00Z"
    });
    expect(checkpoint).toContain("Remaining uncertainty:");
    expect(checkpoint).toContain("1 tool result was failed or lacked confirmed success");
    expect(checkpoint.indexOf("Remaining uncertainty:")).toBeLessThan(checkpoint.indexOf("Verified successful results"));
    expect(checkpoint.length).toBeLessThanOrEqual(12_000);
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
