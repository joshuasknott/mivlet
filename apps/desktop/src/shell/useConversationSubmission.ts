import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  LocalProject,
  MivletAgentProfile,
} from "@mivlet/protocol";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { useScopedComposer } from "../hooks/useScopedComposer";
import { useLocalComputer } from "../hooks/useLocalComputer";
import { resolveWorkspaceMentions } from "../lib/collaboration-mentions";
import { mentionedBuiltinPlugins } from "../lib/builtin-plugins";
import { composerSubmissionText } from "../lib/composer-attachments";
import { prepareExecutionAttachments } from "../lib/execution-attachments";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { useConversationOutputRequests } from "./useConversationOutputRequests";

type Composer = ReturnType<typeof useScopedComposer>;
type LocalComputer = ReturnType<typeof useLocalComputer>;
type MentionResolution = ReturnType<typeof resolveWorkspaceMentions>;
type OutputRequests = ReturnType<typeof useConversationOutputRequests>;
type Owner = ShellRuntime["accountWorkspaceStatus"]["activeContextOwner"];

type SubmissionScope = {
  owner: Owner;
  responderId: string | undefined;
  localAgentId: string;
};

type SubmissionAppScope = {
  active: boolean;
  roomId: string;
  generation: number;
};

/** Owns admission, fencing, staging and persistence for a composer send. */
export function createConversationSubmission({
  composer,
  runtime,
  service,
  room,
  project,
  owner,
  responder,
  replyTarget,
  recipient,
  mentions,
  workspaceMentions,
  localComputer,
  voice,
  appScope,
  submissionScope,
  submission,
  branchParentMessageId,
  setBranchParentMessageId,
  setPending,
  setError,
  stageOutputRevision,
  clearOutputRevision,
  onProjectUpdate,
  scrollToLatest,
}: {
  composer: Composer;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  room: ConversationRoom;
  project?: LocalProject;
  owner: Owner;
  responder?: MivletAgentProfile;
  replyTarget?: CollaborationWorkItem;
  recipient: string;
  mentions: MentionResolution | null;
  workspaceMentions: MentionResolution;
  localComputer: LocalComputer;
  voice: { isBusy: boolean };
  appScope: MutableRefObject<SubmissionAppScope>;
  submissionScope: MutableRefObject<SubmissionScope>;
  submission: MutableRefObject<boolean>;
  branchParentMessageId: string | undefined;
  setBranchParentMessageId: Dispatch<SetStateAction<string | undefined>>;
  setPending: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  stageOutputRevision: OutputRequests["stageOutputRevision"];
  clearOutputRevision: OutputRequests["clearOutputRevision"];
  onProjectUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  scrollToLatest: () => void;
}) {
  return async () => {
    const prompt = composerSubmissionText(composer.text, composer.attachments);
    if (!composer.ready || !prompt || submission.current || voice.isBusy)
      return;
    if (workspaceMentions.errors.length) {
      setError(
        workspaceMentions.errors.join(" ") +
          " Choose an agent from the @ picker.",
      );
      return;
    }
    if (
      workspaceMentions.recipientIds.length &&
      !workspaceMentions.assignment
    ) {
      setError("Add an assignment after the agent mention before sending.");
      return;
    }
    if (composer.replyWorkId && !replyTarget) {
      setError(
        "The assignment for this follow-up is unavailable. Choose a current assignment or send a new request.",
      );
      return;
    }
    if (
      replyTarget &&
      (composer.attachments.length ||
        composer.outcomeGoal ||
        (mentions &&
          (mentions.recipientIds.length !== 1 ||
            mentions.recipientIds[0] !== replyTarget.agentId)))
    ) {
      setError(
        "This follow-up belongs to the selected assignment. Choose New request to change recipients or attach new files.",
      );
      return;
    }
    if (recipient === "discussion" && !room.facilitatorId) {
      setError("Choose a coordinator before requesting a team discussion.");
      return;
    }
    if (!responder) {
      setError(
        mentions
          ? "That mentioned participant is unavailable. Pick a current participant."
          : "Choose an available participant before sending.",
      );
      return;
    }
    if (
      composer.attachments.some(
        (attachment) =>
          !attachment.imageInput &&
          !attachment.sourceId &&
          !attachment.workspaceFile &&
          !attachment.durableRef &&
          !attachment.transientBytes,
      )
    ) {
      setError("Reattach the unavailable file or remove it before sending.");
      return;
    }
    if (!composer.beginSubmission()) return;
    submission.current = true;
    setPending(true);
    setError("");
    try {
      const expectedOwner = owner;
      const expectedRoomGeneration = room.generation;
      const expectedResponder = responder.id;
      const isCurrent = () =>
        appScope.current.active &&
        appScope.current.roomId === room.id &&
        appScope.current.generation === expectedRoomGeneration &&
        submissionScope.current.owner?.internalUserId ===
          expectedOwner?.internalUserId &&
        submissionScope.current.owner?.memberId === expectedOwner?.memberId &&
        submissionScope.current.responderId === expectedResponder;
      await runtime.flushSnapshot();
      await service.refresh();
      if (mentionedBuiltinPlugins(prompt).length)
        await localComputer.prepareForTool("read-file");
      if (project) {
        const sourceIds = composer.attachments.flatMap((attachment) =>
          attachment.sourceId ? [attachment.sourceId] : [],
        );
        if (sourceIds.some((id) => !project.knowledgeSourceIds.includes(id)))
          await onProjectUpdate(project, {
            name: project.name,
            instructions: project.instructions,
            knowledgeSourceIds: [
              ...new Set([...project.knowledgeSourceIds, ...sourceIds]),
            ],
          });
      }
      const revisionWorkId = await stageOutputRevision({
        workspaceId: service.workspaceId,
        agentId: responder.id,
        prompt,
        replying: Boolean(replyTarget),
      });
      if (replyTarget) {
        await service.reply(replyTarget.id, replyTarget.generation, prompt);
      } else {
        if (
          composer.attachments.length &&
          submissionScope.current.localAgentId !== expectedResponder
        )
          throw new Error(
            "Choose this agent as the recipient before staging files for its request.",
          );
        const prepared = composer.attachments.length
          ? await prepareExecutionAttachments(
              composer.attachments,
              localComputer,
              service.workspaceId,
              expectedResponder,
              isCurrent,
            )
          : { attachments: composer.attachments };
        if (!isCurrent())
          throw new Error(
            "The conversation or account changed before this request was saved. Your draft has been kept.",
          );
        await service.submit(
          room.id,
          responder.id,
          prompt,
          recipient === "discussion",
          prepared.attachments,
          mentions?.recipientIds,
          branchParentMessageId,
          revisionWorkId,
          composer.outcomeGoal,
        );
      }
      clearOutputRevision();
      setBranchParentMessageId(undefined);
      await composer.consume(composer.revision);
      scrollToLatest();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not send this message.",
      );
    } finally {
      submission.current = false;
      composer.endSubmission();
      setPending(false);
    }
  };
}
