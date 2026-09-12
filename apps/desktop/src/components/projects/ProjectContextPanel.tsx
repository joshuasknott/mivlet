import { useRef, useState } from "react";
import type {
  CollaborationSnapshot,
  ConversationRoom,
  LocalProject,
  ProjectFact,
} from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import {
  activeWork,
  type WorkspaceExecution,
} from "../../lib/workspace-execution";
import { WorkItems } from "./WorkItems";
import { ProjectFiles } from "./ProjectFiles";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { ACCEPTED_LOCAL_KNOWLEDGE_FILES } from "../../lib/constants";

export function ProjectContextPanel({
  project,
  room,
  data,
  runtime,
  service,
  onOpen,
  onNewConversation,
  onEdit,
  onSchedules,
  onUpdate,
}: {
  project: LocalProject;
  room: ConversationRoom;
  data: CollaborationSnapshot;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  onOpen: (id: string) => void;
  onNewConversation: () => void;
  onEdit: () => void;
  onSchedules: () => void;
  onUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const filesInput = useRef<HTMLInputElement>(null);
  const work = data.work.filter((work) => work.projectId === project.id);
  const team = data.teams.find((team) => team.projectId === project.id);
  const facts = data.facts.filter(
    (fact) => fact.projectId === project.id && fact.status !== "forgotten",
  );
  const references = runtime.workspaceKnowledgeSources.filter(
    (source) =>
      source.workspaceId === service.workspaceId &&
      !source.deletedAt &&
      !source.disabled &&
      (!source.scope || source.scope.level === "global"),
  );
  const files = project.knowledgeSourceIds.map((sourceId) => {
    const source = references.find((source) => source.id === sourceId);
    return {
      sourceId,
      name: source?.title ?? "Unavailable file",
      mediaType: source?.mediaType,
      sizeBytes: source?.sizeBytes,
      provenance:
        source?.provenance ?? "Reimport this file to make it available.",
    };
  });
  const perform = async (action: () => Promise<unknown>) => {
    setError("");
    setPending(true);
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not update this project.",
      );
    } finally {
      setPending(false);
    }
  };
  const saveSources = (ids: string[]) =>
    onUpdate(project, {
      name: project.name,
      instructions: project.instructions,
      knowledgeSourceIds: [...new Set(ids)],
    });
  const saveFact = async (
    text: string,
    kind: ProjectFact["kind"],
    supersedesId?: string,
  ) => {
    await service.command({
      action: "save-fact",
      id: `fact-${crypto.randomUUID()}`,
      projectId: project.id,
      conversationId: room.id,
      kind,
      text,
      source: `User confirmed in ${room.title}`,
      supersedesId,
    });
  };
  return (
    <details className="project-context">
      <summary>
        <span>Project context</span>
        <small>
          {work.filter(activeWork).length} active ·{" "}
          {facts.filter((fact) => fact.status === "current").length} facts &
          decisions · {files.length} files
        </small>
      </summary>
      <div className="project-context__body">
        <div className="project-context__intro">
          <p>
            {project.instructions ||
              "Add instructions to give this project a clear purpose."}
          </p>
          <div>
            <button type="button" onClick={onEdit}>
              Edit project
            </button>
            <button type="button" onClick={onSchedules}>
              Schedules
            </button>
            {work.some(activeWork) ? (
              <button
                type="button"
                onClick={() =>
                  void perform(() => service.stop(project.id, true))
                }
              >
                Stop project
              </button>
            ) : null}
          </div>
        </div>
        <details>
          <summary>
            Conversations{" "}
            <small>
              {
                data.conversations.filter(
                  (room) => room.projectId === project.id,
                ).length
              }
            </small>
          </summary>
          <div className="project-context__conversations">
            {data.conversations
              .filter((room) => room.projectId === project.id)
              .map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  aria-current={
                    room.id === conversation.id ? "page" : undefined
                  }
                  onClick={() => onOpen(conversation.id)}
                >
                  {conversation.title}
                  {conversation.id === project.threadId ? (
                    <small>Main</small>
                  ) : null}
                </button>
              ))}
            <button type="button" onClick={onNewConversation}>
              New focused conversation
            </button>
          </div>
        </details>
        <details>
          <summary>
            Work <small>{work.length}</small>
          </summary>
          <WorkItems work={work} service={service} onOpen={onOpen} />
        </details>
        <details>
          <summary>
            Files & references <small>{files.length}</small>
          </summary>
          <ProjectFiles
            compact
            files={files}
            eligibleSources={references.map((source) => ({
              sourceId: source.id,
              name: source.title,
              mediaType: source.mediaType,
              sizeBytes: source.sizeBytes,
              provenance: source.provenance,
            }))}
            disabled={pending}
            onAttach={(id) =>
              void perform(() =>
                saveSources([...project.knowledgeSourceIds, id]),
              )
            }
            onRemove={(id) =>
              void perform(() =>
                saveSources(
                  project.knowledgeSourceIds.filter((source) => source !== id),
                ),
              )
            }
            onImport={() => filesInput.current?.click()}
          />
          <input
            type="file"
            accept={ACCEPTED_LOCAL_KNOWLEDGE_FILES}
            multiple
            hidden
            ref={filesInput}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void perform(async () => {
                const ids = [...project.knowledgeSourceIds];
                for (const file of files) {
                  const id = await runtime.importKnowledgeFile(file);
                  if (id) ids.push(id);
                }
                await saveSources(ids);
              });
            }}
          />
        </details>
        <details>
          <summary>
            Facts & decisions{" "}
            <small>
              {facts.filter((fact) => fact.status === "current").length}
            </small>
          </summary>
          <div className="project-facts">
            {facts.map((fact) => (
              <article key={fact.id} data-status={fact.status}>
                <header>
                  <strong>
                    {fact.kind === "decision" ? "Decision" : "Fact"}
                  </strong>
                  <small>
                    {fact.confidence === "external-observation"
                      ? "External observation"
                      : fact.confidence}{" "}
                    · {fact.status}
                  </small>
                </header>
                <p>{fact.text}</p>
                <small>
                  {fact.source} ·{" "}
                  {new Date(fact.createdAt).toLocaleDateString()}
                </small>
                <div>
                  <button
                    type="button"
                    onClick={() => onOpen(fact.conversationId)}
                  >
                    View source conversation
                  </button>
                  {fact.status === "current" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void perform(() =>
                          service.command({
                            action: "change-fact",
                            projectId: project.id,
                            id: fact.id,
                            status: "stale",
                          }),
                        )
                      }
                    >
                      Mark stale
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void perform(() =>
                        service.command({
                          action: "change-fact",
                          projectId: project.id,
                          id: fact.id,
                          status: "forgotten",
                        }),
                      )
                    }
                  >
                    Forget
                  </button>
                </div>
                <details>
                  <summary>Correct or supersede</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const text = String(
                        new FormData(event.currentTarget).get("text") ?? "",
                      ).trim();
                      const form = event.currentTarget;
                      void perform(async () => {
                        await saveFact(text, fact.kind, fact.id);
                        form.closest("details")?.removeAttribute("open");
                      });
                    }}
                  >
                    <label>
                      Current {fact.kind}
                      <textarea
                        name="text"
                        defaultValue={fact.text}
                        required
                        maxLength={2000}
                      />
                    </label>
                    <button type="submit" disabled={pending}>
                      Save confirmed correction
                    </button>
                  </form>
                </details>
              </article>
            ))}
            <form
              className="project-facts__new"
              onSubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                const form = event.currentTarget;
                void perform(async () => {
                  await saveFact(
                    String(fields.get("text") ?? "").trim(),
                    fields.get("kind") === "decision" ? "decision" : "fact",
                  );
                  form.reset();
                });
              }}
            >
              <label>
                Record a
                <select name="kind">
                  <option value="decision">Decision</option>
                  <option value="fact">Fact</option>
                </select>
              </label>
              <label>
                Confirmed context
                <textarea
                  name="text"
                  required
                  maxLength={2000}
                  rows={2}
                  placeholder="Record a decision or fact the team should use"
                />
              </label>
              <p className="team-dialog-note">
                Changing confirmed context pauses related active work so the
                team can reconcile its plan.
              </p>
              <button type="submit" disabled={pending}>
                Save confirmed context
              </button>
            </form>
          </div>
        </details>
        <details>
          <summary>
            Participants <small>{team?.participantIds.length ?? 0}</small>
          </summary>
          <div className="project-context__participants">
            {team?.participantIds.map((id) => {
              const agent = runtime.agents.find((agent) => agent.id === id);
              return (
                <span key={id}>
                  {agent ? (
                    <ProfileAgentAvatar agent={agent} iconSize={25} />
                  ) : null}
                  {agent?.name ?? "Removed agent"}
                  {id === team.leadAgentId ? <small>Lead</small> : null}
                </span>
              );
            })}
            <button type="button" onClick={onEdit}>
              Edit participants
            </button>
          </div>
          <p className="team-dialog-note">
            New participants can read project-shared history and records.
            Removing a participant prevents dispatch and pauses its active work;
            historical authorship remains.
          </p>
        </details>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </details>
  );
}
