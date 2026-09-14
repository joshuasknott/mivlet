import { useEffect, useRef } from "react";
import type { CollaborationAgentCommand, LocalProject } from "@fable/protocol";
import {
  collaborationToolSpecs,
  isCollaborationTool,
} from "@fable/connectors/native-api/tools";
import { supportsSharedComputerTools } from "@fable/connectors/native-api/computer-vision";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { useExecutionController } from "./useExecutionController";
import type {
  ExecutionSession,
  WorkspaceExecution,
} from "../lib/workspace-execution";
import {
  attributeConversation,
  collaborationContext,
} from "../lib/collaboration-context";
import { buildAgentRequest, validateModelSelection } from "../lib/agent-run";
import { agentExecutionInstructions } from "../lib/agent-learning";
import { CONVERSATION_STYLE_INSTRUCTIONS } from "../lib/conversation-presentation";
import {
  computerToolsReady,
  conversationToolsForModel,
  COMPUTER_WORK_INSTRUCTIONS,
} from "../lib/computer-tools";
import { builtinPluginInstructions } from "../lib/builtin-plugins";
import { composerImageInputs } from "../lib/composer-images";
import { modelsForProvider } from "../lib/provider-models";
import {
  prepareExecutionAttachments,
  attachmentMessageMetadata,
  attachmentRunInstructions,
  missingRestagedPaths,
  resolveWorkAttachments,
} from "../lib/execution-attachments";
import { stagedAttachmentRefs } from "../lib/workspace-execution";
import { discardRuntimeLocalComputerAttachmentBatch } from "../runtime/domains/local-computer";

/** Mounted by the workspace root, never by a tab. Each admission runs once. */
export function ExecutionWorker({
  session,
  service,
  runtime,
  projects,
}: {
  session: ExecutionSession;
  service: WorkspaceExecution;
  runtime: ShellRuntime;
  projects: LocalProject[];
}) {
  const scope = { id: session.work.id, generation: session.work.generation };
  const attempt = useRef<string | undefined>(undefined);
  const controller = useExecutionController({
    runtime: {
      ...runtime,
      recordBackendToolCall: (event) =>
        runtime.recordBackendToolCall({
          ...event,
          allowAutomatic: session.permissionMode === "full-access",
        }),
    },
    approvalGate: service.approvals.acquire(session.key),
    threadId: session.work.conversationId,
    executionAgentId: session.work.agentId,
    executionProviderId: session.model.providerId,
    onApproval: (id) => service.approval(session, id),
    attributeHistory: (history) =>
      attributeConversation(session.work.capturedContext ? {
        ...history,
        messages: history.messages.filter(view => Boolean(view.message.runId && session.work.runIds.includes(view.message.runId))),
      } : history, service.getSnapshot().data),
    wrapExecutor: (base) => async (approval, args) => {
      const runId = attempt.current;
      if (!runId || !service.current(session))
        throw new Error(
          "This assignment was stopped before the tool could run.",
        );
      await service.command({ action: "check-work", ...scope, runId });
      const name = approval.action.split(/\s+/)[0];
      if (isCollaborationTool(name)) {
        const raw: Record<string, unknown> = JSON.parse(args);
        // Rust strictly validates shapes, membership, generation and replay IDs.
        const command = {
          ...raw,
          kind:
            name === "teammate-assign"
              ? "delegate"
              : name === "project-record"
                ? "record-fact"
                : "await-user",
        } as CollaborationAgentCommand;
        const before = new Set(
          service.getSnapshot().data.work.map((work) => work.id),
        );
        const data = await service.command({
          action: "agent-command",
          ...scope,
          runId,
          callId: approval.id,
          command,
        });
        if (!service.current(session))
          throw new Error(
            "This assignment changed while its handoff was being recorded.",
          );
        return JSON.stringify({
          instructionAuthority: "none",
          state: "recorded",
          assignments: data.work
            .filter((work) => !before.has(work.id))
            .map((work) => ({
              id: work.id,
              agent: work.agentName,
              conversationId: work.conversationId,
              status: work.status,
            })),
          notice:
            name === "teammate-assign"
              ? "Finish this public contribution. Mivlet will resume you with the result; do not poll or impersonate the participant."
              : "Recorded in this task's shared context.",
        });
      }
      const output = await base(approval, args);
      if (!service.current(session))
        throw new Error(
          "The assignment stopped after the tool ran. Its external outcome may need reconciliation; do not repeat the action.",
        );
      await service.command({ action: "check-work", ...scope, runId });
      return output;
    },
  });
  const latest = useRef({ controller, runtime, projects });
  latest.current = { controller, runtime, projects };
  session.cancel = () => latest.current.controller.stopCurrentWork(true);

  useEffect(() => {
    service.publish(session, controller.agent.state);
  }, [controller.agent.state, service, session]);
  useEffect(() => {
    if (!attempt.current || !service.current(session)) return;
    const work = service
      .getSnapshot()
      .data.work.find((work) => work.id === session.work.id);
    const status = runtime.openApprovals.some((approval) =>
      session.approvalIds.has(approval.id),
    )
      ? "awaiting-approval"
      : "running";
    if (
      work &&
      ["running", "awaiting-approval"].includes(work.status) &&
      status !== work.status
    ) {
      void service
        .command({ action: "work-status", ...scope, status })
        .catch((error) => {
          if (service.current(session)) service.report(error);
        });
    }
  }, [runtime.openApprovals, service, session]);

  useEffect(() => {
    if (session.started || runtime.accountWorkspacePending) return;
    session.started = true;
    void (async () => {
      let batch: { computerId: string; batchId: string } | undefined;
      let adopted = false;
      try {
        const { controller, runtime, projects } = latest.current;
        if (!service.current(session)) return;
        const provider = runtime.backendProviders.find(
          (provider) =>
            provider.id === session.model.providerId &&
            provider.authState === "connected",
        );
        if (!provider)
          throw new Error("The selected provider is disconnected.");
        const validation = validateModelSelection(
          provider.id,
          session.model.modelId,
          modelsForProvider(runtime.modelOptions, provider.id),
          2048,
        );
        if (!validation.ok)
          throw new Error(validation.error ?? "This model is unavailable.");
        const resolved = resolveWorkAttachments(session.attachments, session.work);
        if (resolved.error) throw new Error(resolved.error);
        const images = composerImageInputs(resolved.attachments);
        if (!images.ok) throw new Error(images.error);
        if (
          images.images.length &&
          (provider.backendType !== "codex-app-server" ||
            session.model.capabilities?.vision !== true)
        )
          throw new Error(
            "Image understanding requires a connected Codex model that supports images. Reattach the images with a compatible model.",
          );
        controller.resetCancellation();
        const staged = await prepareExecutionAttachments(
          resolved.attachments,
          controller.localComputer,
          service.workspaceId,
          session.work.agentId,
          () => service.current(session),
        );
        if (!service.current(session)) return;
        if (!session.attachments.length) {
          // Continued assignments recover durable workspace refs; files that
          // were cleaned out of the account root fail closed before dispatch.
          // When the listing itself is unavailable, dispatch proceeds and the
          // native bind remains the authority that verifies every reference.
          const entries = await controller.localComputer
            .refreshFiles()
            .catch(() => null);
          const missing = entries
            ? missingRestagedPaths(
                session.work.attachments ?? [],
                entries.entries ?? [],
              )
            : [];
          if (missing.length)
            throw new Error(
              `This request's files are no longer available in the workspace: ${missing
                .map((ref) => ref.name)
                .join(", ")}. Reattach them before continuing.`,
            );
        }
        batch = staged.batch;
        if (!service.current(session)) return;
        const { ids, tools: connectorTools } =
          await controller.beginConnectorTurn();
        if (!service.current(session)) return;
        const data = service.getSnapshot().data;
        const room = data.conversations.find(
          (room) => room.id === session.work.conversationId,
        );
        if (!room) throw new Error("This conversation is no longer available.");
        const project = session.work.projectId
          ? projects.find((project) => project.id === session.work.projectId)
          : undefined;
        if (session.work.projectId && !project)
          throw new Error(
            "Load the current project before continuing this assignment.",
          );
        const tools = conversationToolsForModel(
          connectorTools,
          computerToolsReady(staged.node),
          provider,
          session.model,
          staged.node?.plugins,
          runtime.backendProviders.some(
            (provider) =>
              provider.id === "openai" &&
              provider.authState === "connected" &&
              provider.backendType === "native-api",
          ),
          staged.node?.runtimeAvailable === true,
        );
        const toolCapable =
          supportsSharedComputerTools(provider) &&
          session.model.capabilities?.tools !== false;
        if (room.kind === "group" && toolCapable)
          tools.push(...collaborationToolSpecs(Boolean(project)));
        if (room.kind === "group" && !toolCapable)
          throw new Error(
            "This model does not support the collaboration tools. Choose a tool-capable model for this participant.",
          );
        const context = await runtime.assembleConversationContext(
          session.work.prompt,
          {
            threadId: room.id,
            allowedConnectorIds: ids,
            allowedKnowledgeSourceIds: [
              ...new Set([
                ...(project?.knowledgeSourceIds ?? []),
                ...staged.attachments.flatMap((attachment) =>
                  attachment.sourceId ? [attachment.sourceId] : [],
                ),
              ]),
            ],
            excludePrivateMemory: Boolean(session.work.capturedContext) || room.kind === "group",
          },
        );
        if (!service.current(session)) return;
        const instructions = [
          session.work.capturedContext ? `Captured request context (${session.work.capturedContext.capturedAt}):\n${session.work.capturedContext.text}` : agentExecutionInstructions(session.profile),
          CONVERSATION_STYLE_INSTRUCTIONS,
          service.isVoice(session) ? "This is a voice conversation. Reply concisely in natural spoken sentences; keep normal tool approvals and never speak private reasoning." : "",
          tools.some(tool => tool.name === "read-file") ? COMPUTER_WORK_INSTRUCTIONS : "Computer and workspace file tools are unavailable on this request. Explain this limitation if relevant. Do not claim to have created, read or published files without successful tool results.",
          builtinPluginInstructions(
            session.work.prompt,
            staged.node?.plugins,
            tools.map((tool) => tool.name),
          ),
          collaborationContext(session.work, data, project),
          attachmentRunInstructions(staged.attachments),
        ]
          .filter(Boolean)
          .join("\n\n");
        const outcome = await controller.agent.run(
          buildAgentRequest({
            model: session.model.modelId,
            reasoningEffort: session.profile.reasoningEffort,
            prompt: session.work.userRequest,
            images: images.images,
            instructions,
            tools,
            maxTokens: validation.maxTokens,
          }),
          context,
          session.permissionMode,
          undefined,
          {
            maxTurns: 6,
            onTextDelta: (text) => service.voiceText(session, text),
            canonicalUserMessage:
              session.work.parentId || session.work.runIds.length > 0
                ? "suppress"
                : "persist",
            attachments: attachmentMessageMetadata(
              staged.attachments,
              Boolean(project),
            ),
            afterAttemptQueued: async ({ attemptId, threadId }) => {
              if (
                threadId !== session.work.conversationId ||
                !service.current(session)
              )
                throw new Error("This assignment was stopped before dispatch.");
              await service.command({
                action: "bind-work",
                ...scope,
                runId: attemptId,
                attachments: stagedAttachmentRefs(staged.attachments),
              });
              if (!service.current(session))
                throw new Error("This assignment changed before dispatch.");
              attempt.current = attemptId;
              adopted = true;
            },
          },
        );
        if (!service.current(session)) return;
        if (attempt.current && outcome) {
          await service.command({
            action: "finish-work",
            ...scope,
            runId: attempt.current,
            status:
              outcome.status === "completed"
                ? "completed"
                : outcome.status === "cancelled"
                  ? "cancelled"
                  : "failed",
            reason: outcome.error,
          });
        } else
          throw new Error(
            outcome?.error ??
              latest.current.controller.agent.state.lastError ??
              "The provider did not start. Check its connection and retry explicitly.",
          );
      } catch (error) {
        if (service.current(session)) {
          const reason =
            error instanceof Error ? error.message : "The assignment failed.";
          await service
            .command({
              action: "work-status",
              ...scope,
              status: "failed",
              reason,
            })
            .catch((error) => service.report(error));
        }
      } finally {
        if (batch && !adopted)
          await discardRuntimeLocalComputerAttachmentBatch({
            workspaceId: service.workspaceId,
            agentId: session.work.agentId,
            ...batch,
          }).catch(() => undefined);
        latest.current.controller.endConnectorTurn();
        latest.current.runtime.clearBackendToolApprovals([
          ...session.approvalIds,
        ]);
        await service.released(session);
      }
    })();
    // StrictMode effect replay sees session.started. View mounts never own this effect.
  }, [service, session, runtime.accountWorkspacePending]);
  return null;
}
