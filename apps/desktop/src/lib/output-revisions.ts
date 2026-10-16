/**
 * Durable output editing contracts.
 *
 * Output revisions are deliberately separate from conversation message
 * revisions. A response can produce an output, while later user and agent
 * edits become immutable output revisions. The native repository is the
 * authority; these helpers provide the same validation and optimistic
 * concurrency rules to the renderer and browser preview.
 */

const MAX_OUTPUT_TITLE_CHARACTERS = 160;
const MAX_OUTPUT_CONTENT_CHARACTERS = 1_048_576;

export type OutputFormat =
  | "text"
  | "markdown"
  | "json"
  | "csv"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "image";

type OutputRevisionAuthor = "user" | "agent" | "system";

export interface OutputSource {
  conversationId: string;
  branchId?: string;
  messageId?: string;
  sourceRevisionId?: string;
  artifactId?: string;
  agentId?: string;
}

interface OutputProvenance extends OutputSource {
  reason: "generated" | "direct-edit" | "agent-revision" | "restore";
}

export interface OutputRevision {
  id: string;
  outputId: string;
  number: number;
  baseNumber: number;
  content: string;
  author: OutputRevisionAuthor;
  provenance: OutputProvenance;
  createdAt: string;
}

interface OutputPin {
  revisionId: string;
  source: OutputSource;
}

export interface OutputDocument {
  id: string;
  title: string;
  format: OutputFormat;
  mimeType: string;
  source: OutputSource;
  revisions: readonly OutputRevision[];
  currentRevisionId: string;
  currentRevisionNumber: number;
  pinned: boolean;
  pinnedAt?: string;
  pin?: OutputPin;
  updatedAt: string;
}

export interface NewOutputInput {
  id: string;
  title: string;
  format: OutputFormat;
  mimeType: string;
  source: OutputSource;
  content: string;
  author?: OutputRevisionAuthor;
  reason?: OutputProvenance["reason"];
  now?: string;
}

export interface AppendOutputRevisionInput {
  outputId: string;
  expectedRevisionId: string;
  expectedRevisionNumber: number;
  content: string;
  author: OutputRevisionAuthor;
  provenance: OutputProvenance;
  revisionId?: string;
  now?: string;
}

export class StaleOutputRevisionError extends Error {
  readonly code = "stale-output-revision";

  constructor() {
    super(
      "This output changed in another pane. Reload it before saving your edit.",
    );
    this.name = "StaleOutputRevisionError";
  }
}

function assertNonEmpty(value: string, label: string, max: number) {
  if (!value.trim() || value.length > max) {
    throw new Error(
      `${label} must be between 1 and ${max.toLocaleString()} characters.`,
    );
  }
}

function assertContent(value: string) {
  if (value.length > MAX_OUTPUT_CONTENT_CHARACTERS) {
    throw new Error("This output is too large to edit in Mivlet.");
  }
}

function assertSource(source: OutputSource) {
  assertNonEmpty(source.conversationId, "The source conversation", 256);
  for (const [label, value] of Object.entries(source)) {
    if (value !== undefined) assertNonEmpty(value, label, 256);
  }
}

function createRevision(
  outputId: string,
  number: number,
  input: Pick<NewOutputInput, "content" | "author" | "reason" | "source"> & {
    now: string;
    revisionId: string;
  },
): OutputRevision {
  assertContent(input.content);
  return {
    id: input.revisionId,
    outputId,
    number,
    baseNumber: number - 1,
    content: input.content,
    author: input.author ?? "system",
    provenance: { ...input.source, reason: input.reason ?? "generated" },
    createdAt: input.now,
  };
}

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function createOutputDocument(input: NewOutputInput): OutputDocument {
  assertNonEmpty(input.id, "The output id", 256);
  assertNonEmpty(input.title, "The output title", MAX_OUTPUT_TITLE_CHARACTERS);
  assertSource(input.source);
  assertContent(input.content);
  const now = input.now ?? new Date().toISOString();
  const revision = createRevision(input.id, 1, {
    content: input.content,
    author: input.author,
    reason: input.reason,
    source: input.source,
    now,
    revisionId: randomId("output-revision"),
  });
  return {
    id: input.id,
    title: input.title.trim(),
    format: input.format,
    mimeType: input.mimeType,
    source: { ...input.source },
    revisions: [revision],
    currentRevisionId: revision.id,
    currentRevisionNumber: 1,
    pinned: false,
    updatedAt: now,
  };
}

export function currentOutputRevision(output: OutputDocument): OutputRevision {
  const revision = output.revisions.find(
    (item) => item.id === output.currentRevisionId,
  );
  if (!revision || revision.number !== output.currentRevisionNumber) {
    throw new Error("The saved output has an invalid current revision.");
  }
  return revision;
}

export function appendOutputRevision(
  output: OutputDocument,
  input: AppendOutputRevisionInput,
): OutputDocument {
  if (input.outputId !== output.id)
    throw new Error("The output identity changed before saving.");
  if (
    input.expectedRevisionId !== output.currentRevisionId ||
    input.expectedRevisionNumber !== output.currentRevisionNumber
  ) {
    throw new StaleOutputRevisionError();
  }
  assertContent(input.content);
  assertSource(input.provenance);
  const now = input.now ?? new Date().toISOString();
  const revision: OutputRevision = {
    id: input.revisionId ?? randomId("output-revision"),
    outputId: output.id,
    number: output.currentRevisionNumber + 1,
    baseNumber: output.currentRevisionNumber,
    content: input.content,
    author: input.author,
    provenance: { ...input.provenance },
    createdAt: now,
  };
  return {
    ...output,
    revisions: [...output.revisions, revision],
    currentRevisionId: revision.id,
    currentRevisionNumber: revision.number,
    updatedAt: now,
  };
}

/** Restoring creates a new revision; it never rewrites or deletes history. */
export function restoreOutputRevision(
  output: OutputDocument,
  revisionNumber: number,
  expectedRevisionId: string,
  expectedRevisionNumber: number,
  source: OutputSource,
  now?: string,
): OutputDocument {
  const target = output.revisions.find(
    (revision) => revision.number === revisionNumber,
  );
  if (!target) throw new Error("That output revision is no longer available.");
  return appendOutputRevision(output, {
    outputId: output.id,
    expectedRevisionId,
    expectedRevisionNumber,
    content: target.content,
    author: "user",
    provenance: { ...source, reason: "restore" },
    now,
  });
}

export function setOutputPinned(
  output: OutputDocument,
  pinned: boolean,
  now = new Date().toISOString(),
  source?: OutputSource,
  revisionId?: string,
): OutputDocument {
  const pinRevisionId = revisionId ?? output.currentRevisionId;
  const pinRevision = output.revisions.find((revision) => revision.id === pinRevisionId);
  if (pinned && !output.revisions.some((revision) => revision.id === pinRevisionId)) {
    throw new Error("That output revision is no longer available.");
  }
  const pinSource = source ?? (pinRevision
    ? (() => {
        const { reason: _reason, ...revisionSource } = pinRevision.provenance;
        return revisionSource;
      })()
    : output.source);
  return {
    ...output,
    pinned,
    pinnedAt: pinned ? now : undefined,
    pin: pinned
      ? { revisionId: pinRevisionId, source: { ...pinSource } }
      : undefined,
    updatedAt: now,
  };
}

export function outputRevisionDiff(
  output: OutputDocument,
  leftNumber: number,
  rightNumber: number,
) {
  const left = output.revisions.find(
    (revision) => revision.number === leftNumber,
  );
  const right = output.revisions.find(
    (revision) => revision.number === rightNumber,
  );
  if (!left || !right)
    throw new Error("That output revision is no longer available.");
  return { left, right, changed: left.content !== right.content };
}

export interface OutputRevisionRequest {
  outputId: string;
  expectedRevisionId: string;
  expectedRevisionNumber: number;
  content: string;
  selection: string;
  source: OutputSource;
}

function isConflict(failure: unknown) {
  const message = failure instanceof Error ? failure.message.toLowerCase() : "";
  return message.includes("changed in another pane") || message.includes("newer revision") || message.includes("stale");
}
