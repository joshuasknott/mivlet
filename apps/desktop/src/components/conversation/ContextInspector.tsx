import { useEffect, useRef, useState } from "react";
import type {
  CollaborationWorkItem,
  ConversationContextPreview,
  ConversationContextSelection,
  ExecutionAttempt,
  PreparedExecutionContext,
} from "@mivlet/protocol";
import { conversationUi } from "../../runtime/domains/conversation-ui";
import { listRuntimeExecutionAttempts } from "../../runtime/domains/workspace";
import type { ComposerAttachment } from "../../lib/types";
import "./context-inspector.css";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function captureBody(text?: string) {
  try {
    return record(JSON.parse(text ?? "{}"));
  } catch {
    return {};
  }
}
function scopeLabel(scope: unknown) {
  const value = record(scope);
  return String(value.level ?? "conversation");
}

export function ContextInspector({
  workspaceId,
  conversationId,
  agentId,
  revision,
  work,
  attachments,
  onError,
  draft,
  files = [],
  prepareRetrieval,
}: {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  revision: number;
  work: CollaborationWorkItem[];
  attachments: ComposerAttachment[];
  onError?: (message: string) => void;
  draft?: string;
  files?: { id: string; title: string }[];
  prepareRetrieval?: (
    query: string,
    selection: ConversationContextSelection,
  ) => Promise<PreparedExecutionContext>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ConversationContextPreview>();
  const [attempts, setAttempts] = useState<ExecutionAttempt[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const epoch = useRef(0);
  const [retrieval, setRetrieval] = useState<PreparedExecutionContext>();
  const [retrievalError, setRetrievalError] = useState("");
  const prepare = useRef(prepareRetrieval);
  prepare.current = prepareRetrieval;
  const selectionKey = JSON.stringify(preview?.selection);
  useEffect(() => {
    let current = true;
    setRetrieval(undefined);
    setRetrievalError("");
    if (!open || !preview || !draft?.trim() || !prepare.current) return;
    const timer = setTimeout(() => {
      void prepare.current!(draft, preview.selection)
        .then((value) => {
          if (current) setRetrieval(value);
        })
        .catch((reason) => {
          if (current)
            setRetrievalError(
              reason instanceof Error ? reason.message : String(reason),
            );
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, draft, selectionKey, workspaceId, conversationId, agentId]);
  useEffect(() => {
    const current = ++epoch.current;
    setPreview(undefined);
    setError("");
    setAttempts([]);
    setSaving(false);
    if (!open) return;
    void Promise.all([
      conversationUi<ConversationContextPreview>(
        { workspaceId, conversationId, agentId },
        { action: "preview-context" },
      ),
      listRuntimeExecutionAttempts(),
    ])
      .then(([next, runs]) => {
        if (current !== epoch.current) return;
        setPreview(next);
        setAttempts(
          (runs ?? []).filter((run) =>
            run.threadId === conversationId &&
            (!run.contextReceipt?.scope.agentId || run.contextReceipt.scope.agentId === agentId),
          ),
        );
      })
      .catch((reason) => {
        if (current === epoch.current)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      epoch.current++;
    };
  }, [open, workspaceId, conversationId, agentId, revision]);
  const update = async (selection: ConversationContextSelection) => {
    const current = epoch.current;
    setSaving(true);
    try {
      const next = await conversationUi<ConversationContextPreview>(
        { workspaceId, conversationId, agentId },
        { action: "set-context", selection },
      );
      if (current === epoch.current) {
        setPreview(next);
        setError("");
      }
    } catch (reason) {
      if (current === epoch.current) {
        const text = reason instanceof Error ? reason.message : String(reason);
        setError(text);
        onError?.(text);
      }
    } finally {
      if (current === epoch.current) setSaving(false);
    }
  };
  const body = captureBody(preview?.capture.text);
  const memories = entries(body.approvedScopedMemory);
  const history = entries(body.history);
  const summaries = entries(body.derivedSummaries);
  const last = [...work]
    .filter((item) => item.conversationId === conversationId && item.agentId === agentId && item.capturedContext)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (
    <details
      className="context-inspector"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Context
        {preview
          ? ` · ${memories.length} memories · ${history.length} messages`
          : ""}
      </summary>
      <div className="context-inspector__body">
        <h3>Proposed next-turn context</h3>
        <p>
          Native scoped snapshot. Refreshed at admission; file retrieval and
          final compaction depend on your next request and selected model.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        {!preview && !error ? (
          <p role="status">Reading the native context assembly…</p>
        ) : null}
        {preview ? (
          <>
            <small>
              Captured{" "}
              {new Date(preview.capture.capturedAt).toLocaleTimeString()} ·
              source revision {preview.capture.sourceRevision}
            </small>
            <fieldset disabled={saving}>
              <legend>Include for the next request</legend>
              <label>
                <input
                  type="checkbox"
                  checked={preview.selection.includeHistory}
                  onChange={(event) =>
                    void update({
                      ...preview.selection,
                      includeHistory: event.target.checked,
                    })
                  }
                />
                Conversation history and its summaries
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={preview.selection.includeProjectFacts}
                  onChange={(event) =>
                    void update({
                      ...preview.selection,
                      includeProjectFacts: event.target.checked,
                    })
                  }
                />
                Confirmed project facts and decisions
              </label>
              {memories.map((memory) => (
                <label key={String(memory.id)}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      void update({
                        ...preview.selection,
                        excludedMemoryIds: [
                          ...preview.selection.excludedMemoryIds,
                          String(memory.id),
                        ],
                      })
                    }
                  />
                  <span>
                    {String(memory.value ?? "")}
                    <small>
                      {scopeLabel(memory.scope)} ·{" "}
                      {String(memory.source ?? "Saved memory")}
                    </small>
                  </span>
                </label>
              ))}
              {preview.selection.excludedMemoryIds.map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() =>
                      void update({
                        ...preview.selection,
                        excludedMemoryIds:
                          preview.selection.excludedMemoryIds.filter(
                            (excluded) => excluded !== id,
                          ),
                      })
                    }
                  />
                  Excluded memory · {id}
                </label>
              ))}
              {files.map((file) => (
                <label key={file.id}>
                  <input
                    type="checkbox"
                    checked={
                      !preview.selection.excludedKnowledgeSourceIds.includes(
                        file.id,
                      )
                    }
                    onChange={(event) =>
                      void update({
                        ...preview.selection,
                        excludedKnowledgeSourceIds: event.target.checked
                          ? preview.selection.excludedKnowledgeSourceIds.filter(
                              (id) => id !== file.id,
                            )
                          : [
                              ...preview.selection.excludedKnowledgeSourceIds,
                              file.id,
                            ],
                      })
                    }
                  />
                  {file.title}
                  <small>
                    File retrieval candidate; scope and connection checks still
                    apply
                  </small>
                </label>
              ))}
            </fieldset>
            <p>
              {history.length} recent messages · {summaries.length} valid
              derived summaries · {entries(body.confirmedProjectFacts).length}{" "}
              confirmed project facts.
            </p>
            {record(body.transcriptSummary).text ? (
              <p>
                Older history uses a bounded local extract. It is prior
                evidence, not new instructions.
              </p>
            ) : null}
            <details>
              <summary>Inspect captured content and provenance</summary>
              <pre>{JSON.stringify(body, null, 2)}</pre>
            </details>
            <p className="context-inspector__note">
              Excluding memory prevents its retrieval and derived summaries. Its
              words may still appear in conversation history; exclude history
              too when needed. Correct or forget a memory in Memories.
            </p>
          </>
        ) : null}
        <h4>Files attached to the draft</h4>
        {attachments.length ? (
          <ul>
            {attachments.map((file) => (
              <li key={file.id}>
                {file.name} ·{" "}
                {file.sourceId
                  ? "Scoped source; bounded retrieval at dispatch"
                  : file.workspaceFile
                    ? "Workspace file; native verification at dispatch"
                    : "Must remain available until sent"}
              </li>
            ))}
          </ul>
        ) : (
          <p>No files attached to this draft.</p>
        )}
        {prepareRetrieval ? (
          <>
            <h4>Retrieval for this draft</h4>
            <p>
              Uses the same scoped retrieval and character budget as execution.
              Connections and sources are revalidated when you send.
            </p>
            {!draft?.trim() ? (
              <p>Type a request to inspect relevant passages.</p>
            ) : retrievalError ? (
              <p role="alert">{retrievalError}</p>
            ) : retrieval ? (
              <details>
                <summary>
                  {retrieval.receipt.citations.length} selected passages ·{" "}
                  {new Date(retrieval.receipt.assembledAt).toLocaleTimeString()}
                </summary>
                <pre>
                  {retrieval.systemPrefix || "No additional passages matched."}
                </pre>
                <pre>{JSON.stringify(retrieval.receipt, null, 2)}</pre>
              </details>
            ) : (
              <p role="status">Assembling relevant passages…</p>
            )}
          </>
        ) : null}
        <h3>Previously admitted context</h3>
        {last?.capturedContext ? (
          <details>
            <summary>
              {last.agentName} · {new Date(last.createdAt).toLocaleString()} ·{" "}
              {last.status}
            </summary>
            <p>
              Frozen when this work was admitted. This record alone does not
              prove a provider call occurred.
            </p>
            <pre>
              {JSON.stringify(captureBody(last.capturedContext.text), null, 2)}
            </pre>
          </details>
        ) : (
          <p>No saved work capture for this agent yet.</p>
        )}
        {attempts
          .filter((attempt) => attempt.contextReceipt)
          .slice(-6)
          .map((attempt) => (
            <details key={attempt.id}>
              <summary>
                Request receipt · {attempt.status} · {attempt.id}
              </summary>
              <p>
                Actual assembled retrieval receipt saved for this attempt.
                Provider acceptance is recorded by the attempt’s outcome.
              </p>
              <pre>{JSON.stringify(attempt.contextReceipt, null, 2)}</pre>
            </details>
          ))}
      </div>
    </details>
  );
}
