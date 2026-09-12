import type { VoicePromptControl } from "@fable/connectors/voice";
import { activeWork, type WorkspaceExecution } from "./workspace-execution";

/** Voice owns only its submitted exchange; drafts and other panes stay independent. */
export async function runWorkspaceVoice(service: WorkspaceExecution, text: string, control: VoicePromptControl) {
  if (control.signal.aborted) return;
  if (control.scope.workspaceId !== service.workspaceId) throw new Error("This voice workspace has changed.");
  const id = await service.submit(control.scope.threadId, control.scope.agentId, text, false, [], delta => {
    if (!control.signal.aborted) control.onText(delta);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stopping = false;
      let unsubscribe = () => {};
      const cleanup = () => { unsubscribe(); control.signal.removeEventListener("abort", abort); };
      const abort = () => {
        if (stopping) return;
        stopping = true;
        void service.stop(id).then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
      };
      const check = () => {
        if (stopping) return;
        const state = service.getSnapshot();
        const work = state.data.work.find(item => item.id === id);
        if (!work || activeWork(work) || state.sessions.some(session => session.work.id === id)) return;
        cleanup();
        if (work.status === "failed" || work.status === "blocked") reject(new Error(work.reason || "The voice request could not finish."));
        else resolve();
      };
      unsubscribe = service.subscribe(check);
      control.signal.addEventListener("abort", abort, { once: true });
      if (control.signal.aborted) abort(); else check();
    });
  } finally {
    service.releaseVoice(id);
  }
}
