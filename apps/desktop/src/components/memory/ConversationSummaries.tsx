import { useEffect, useState } from "react";
import type { ContextSummaryRecord } from "@fable/protocol";
import { listRuntimeContextSummaries } from "../../runtime";
import { ContextSummaryList } from "./ContextSummaryList";

export function ConversationSummaries({ threadId, revision }: { threadId: string; revision: string }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<ContextSummaryRecord[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let current = true;
    setRecords([]);
    setError("");
    void listRuntimeContextSummaries(threadId).then(records => {
      if (current) setRecords(records ?? []);
    }).catch(() => { if (current) setError("Could not load conversation summaries."); });
    return () => { current = false; };
  }, [threadId, revision, open]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Conversation summaries</summary>
    {error ? <p role="alert">{error}</p> : <ContextSummaryList summaries={records} />}
  </details>;
}
