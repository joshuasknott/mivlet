import { useEffect, useRef } from "react";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import type { OutputDocument } from "../../lib/output-revisions";
import { conversationUi } from "../../runtime/domains/conversation-ui";
import { emitOutputRevisionApplied } from "../../lib/output-revision-events";

/** Saved responses alone never create revisions. Native authority reconciles
 * the explicit request, owning agent, generation and immutable output base. */
export function useOutputRevisions(workspaceId: string, conversationId: string, work: CollaborationWorkItem[], selectedHeadId: string | undefined, onError: (message: string) => void) {
  const report = useRef(onError);
  report.current = onError;
  const signature = work.filter((item) => item.status === "completed").map((item) => `${item.id}:${item.generation}`).join("|");
  const completed = useRef(work);
  completed.current = work;
  useEffect(() => {
    let active = true;
    void (async () => {
      for (const agentId of new Set(completed.current.filter((candidate) => candidate.status === "completed").map((item) => item.agentId))) {
        if (!active) return;
        try {
          const result = await conversationUi<{ outputs: OutputDocument[]; errors: { workId: string; message: string }[] }>(
            { workspaceId, conversationId, agentId },
            { action: "apply-output-revisions" },
          );
          if (active) {
            for (const output of result.outputs) emitOutputRevisionApplied({ outputId: output.id, conversationId, output });
            if (result.errors.length) report.current(`The output was preserved: ${result.errors[0]!.message}`);
          }
        } catch (error) {
          if (active) report.current(`The output was preserved: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    return () => { active = false; };
  }, [workspaceId, conversationId, signature, selectedHeadId]);
}
