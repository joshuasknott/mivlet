import { parseComposerText } from "@fable/connectors";
import type { Spine } from "@fable/protocol";
import type { RuntimeConversationMessageView } from "../runtime";

export interface ProjectMissionRerunSource {
  sourceCommand: string;
  sourceMessageId: string;
}

export function matchesTerminalGeneralRetryStatus(
  status: Spine.Missions.RunStatus
): boolean {
  return status === "partially-completed"
    || status === "failed"
    || status === "cancelled";
}

/**
 * Resolve a fresh general-Mission launch only from the canonical transcript
 * records written by the exact run. This avoids inferring a command from an
 * unrelated preceding message or treating another Mission shape as rerunnable.
 */
export function resolveProjectMissionRerunSource(
  messages: readonly RuntimeConversationMessageView[],
  runId: string
): ProjectMissionRerunSource {
  const runMessages = messages
    .filter(({ message }) => message.runId === runId)
    .sort((left, right) => left.message.sequence - right.message.sequence);
  const sourceRequests = runMessages.filter(({ message }) => message.kind === "user");
  const assistant = runMessages.find(({ message }) => message.kind === "assistant");

  if (sourceRequests.length !== 1 || !assistant) {
    throw new Error("Fable could not verify the original Mission request.");
  }

  const sourceRequest = sourceRequests[0];
  if (!sourceRequest) {
    throw new Error("Fable could not verify the original Mission request.");
  }
  const content = sourceRequest.currentRevision.content;
  if (typeof content !== "string") {
    throw new Error("Fable could not verify the original Mission request.");
  }
  const sourceCommand = content.trim();
  const parsed = parseComposerText(sourceCommand);
  if (parsed.status !== "command" || parsed.request.name !== "mission") {
    throw new Error("Only general Missions with an exact saved /mission request can run again here.");
  }

  return {
    sourceCommand,
    sourceMessageId: assistant.message.id
  };
}
