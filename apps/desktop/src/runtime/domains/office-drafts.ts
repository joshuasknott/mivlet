import type { LocalComputerOfficePreview } from "@mivlet/protocol";
import { activeDataScope, hasTauriRuntime, invoke } from "../bridge";

interface OfficeDraftRevisionSummary {
  number: number;
  editCount: number;
  edits: OfficeDraftEdit[];
  author: string;
  createdAt: string;
  provenance: string;
}

interface OfficeDraftEdit {
  kind: string;
  entry: string;
  selector: string;
  replacement: string;
}

export interface OfficeDraft {
  artifactId: string;
  conversationId: string;
  agentId: string;
  title: string;
  extension: string;
  currentRevisionNumber: number;
  revisions: OfficeDraftRevisionSummary[];
  preview?: LocalComputerOfficePreview;
  previewTruncated: boolean;
}

export interface OfficeDraftTarget {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  artifactId: string;
  expectedGeneration: number;
}

export interface OfficeDraftSelection {
  selection: string;
  reference: string;
  revisionNumber: number;
}

function workspace(expected: string) {
  const actual = activeDataScope()?.workspaceId;
  if (!actual || actual !== expected)
    throw new Error(
      "The selected workspace changed before the Office draft was saved.",
    );
  return actual;
}

export async function getOfficeDraft(
  target: OfficeDraftTarget,
  revisionNumber?: number,
): Promise<OfficeDraft | null> {
  const workspaceId = workspace(target.workspaceId);
  if (!hasTauriRuntime()) return null;
  return invoke<OfficeDraft | null>("office_draft_get", {
    request: {
      workspaceId,
      conversationId: target.conversationId,
      agentId: target.agentId,
      artifactId: target.artifactId,
      ...(revisionNumber === undefined ? {} : { revisionNumber }),
    },
  });
}

export async function saveOfficeDraftEdit(
  target: OfficeDraftTarget,
  input: {
    expectedRevisionNumber: number;
    kind: "cell" | "paragraph";
    entry: string;
    selector: string;
    replacement: string;
    proposalOutputId?: string;
    proposalRevisionId?: string;
  },
): Promise<OfficeDraft> {
  const workspaceId = workspace(target.workspaceId);
  if (!hasTauriRuntime())
    throw new Error("Edit Office files in the Mivlet desktop app.");
  return invoke<OfficeDraft>("office_draft_save", {
    request: { ...target, workspaceId, ...input },
  });
}

export async function inspectOfficeDraftSelection(
  target: OfficeDraftTarget,
  input: {
    expectedRevisionNumber: number;
    kind: "cell" | "paragraph";
    entry: string;
    selector: string;
    sectionIndex?: number;
  },
): Promise<OfficeDraftSelection> {
  const workspaceId = workspace(target.workspaceId);
  if (!hasTauriRuntime())
    throw new Error("Inspect Office selections in the Mivlet desktop app.");
  return invoke<OfficeDraftSelection>("office_draft_selection", {
    request: { ...target, workspaceId, ...input },
  });
}

export async function restoreOfficeDraft(
  target: OfficeDraftTarget,
  revisionNumber: number,
  expectedRevisionNumber: number,
): Promise<OfficeDraft> {
  const workspaceId = workspace(target.workspaceId);
  if (!hasTauriRuntime())
    throw new Error("Restore Office drafts in the Mivlet desktop app.");
  return invoke<OfficeDraft>("office_draft_restore", {
    request: { ...target, workspaceId, revisionNumber, expectedRevisionNumber },
  });
}

export async function exportOfficeDraft(
  target: OfficeDraftTarget,
  revisionNumber: number,
  expectedRevisionNumber: number,
): Promise<boolean> {
  const workspaceId = workspace(target.workspaceId);
  if (!hasTauriRuntime())
    throw new Error("Export Office drafts in the Mivlet desktop app.");
  return invoke<boolean>("office_draft_export", {
    request: { ...target, workspaceId, revisionNumber, expectedRevisionNumber },
  });
}
