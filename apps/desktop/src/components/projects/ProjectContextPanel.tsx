import { useRef, useState } from "react";
import type {
  AddProjectContextShareInput,
  CollaborationSnapshot,
  ConversationRoom,
  LocalProject,
  ProjectContextShare,
  ProjectFact,
  ProjectShareMode,
  ProjectShareSourceKind,
} from "@mivlet/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import {
  activeWork,
  type WorkspaceExecution,
} from "../../lib/workspace-execution";
import { ProjectFiles } from "./ProjectFiles";
import { TeamReadiness } from "./TeamReadiness";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { ACCEPTED_LOCAL_KNOWLEDGE_FILES } from "../../lib/constants";

interface ShareSourceOption {
  key: string;
  kind: ProjectShareSourceKind;
  id: string;
  title: string;
  sourceRevision: string;
  snapshotText?: string;
}

export function ProjectContextPanel({
  project,
  room,
  data,
  runtime,
  service,
  onOpen,
  onEdit,
  onSchedules,
  onUpdate,
  onAddShare,
  onRemoveShare,
}: {
  project: LocalProject;
  room: ConversationRoom;
  data: CollaborationSnapshot;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  onOpen: (id: string) => void;
  onEdit: () => void;
  onSchedules: () => void;
  onUpdate: (
    project: LocalProject,
    patch: Pick<LocalProject, "name" | "instructions" | "knowledgeSourceIds">,
  ) => Promise<void>;
  onAddShare: (share: AddProjectContextShareInput["share"]) => Promise<void>;
  onRemoveShare: (shareId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [shareMode, setShareMode] = useState<ProjectShareMode>("snapshot");
  const [recipient, setRecipient] = useState("project");
  const [sourceKey, setSourceKey] = useState("");
  const [snapshotDraft, setSnapshotDraft] = useState("");
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
  const shareSources: ShareSourceOption[] = [
    ...files.flatMap((file) =>
      file.sourceId
        ? [
            {
              key: `file:${file.sourceId}`,
              kind: "file" as const,
              id: file.sourceId,
              title: file.name,
              sourceRevision:
                references.find((source) => source.id === file.sourceId)
                  ?.contentFingerprint ?? "current",
            },
          ]
        : [],
    ),
    ...work.flatMap((item) =>
      item.outputs.map((output) => ({
        key: `work:${item.id}:${output.runId}`,
        kind: "work" as const,
        id: item.id,
        title: `${item.agentName}: ${item.prompt.slice(0, 70)}`,
        sourceRevision: output.runId,
        snapshotText: output.text,
      })),
    ),
    {
      key: `conversation:${room.id}`,
      kind: "conversation" as const,
      id: room.id,
      title: `${room.title} history`,
      sourceRevision: String(room.revision),
    },
  ];
  const selectedSource = shareSources.find((source) => source.key === sourceKey);
  const submitShare = async () => {
    if (!selectedSource) {
      setError("Choose a file, result or conversation to share.");
      return;
    }
    await onAddShare({
      mode: shareMode,
      source: {
        workspaceId: service.workspaceId,
        kind: selectedSource.kind,
        id: selectedSource.id,
      },
      sourceRevision: selectedSource.sourceRevision,
      recipient:
        recipient === "project"
          ? { kind: "project", id: project.id }
          : { kind: "agent", id: recipient },
      owner: { kind: "user", name: "You" },
      title: selectedSource.title,
      snapshotText:
        shareMode === "snapshot"
          ? snapshotDraft || selectedSource.snapshotText || ""
          : undefined,
    });
    setSnapshotDraft("");
  };
  const recipientName = (share: ProjectContextShare) =>
    share.recipient.kind === "project"
      ? "Whole project"
      : runtime.agents.find((agent) => agent.id === share.recipient.id)?.name ??
        "Removed agent";
  return (
    <section className="project-context" aria-label={project.name}>
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
            Shared context <small>{project.shares.length}</small>
          </summary>
          <div className="project-shares">
            {project.shares.map((share) => (
              <article key={share.id} data-mode={share.mode}>
                <header>
                  <strong>{share.title}</strong>
                  <small>
                    {share.mode === "snapshot" ? "Snapshot" : "Live reference"} ·{" "}
                    {share.owner.kind === "agent"
                      ? `Shared by ${share.owner.name}`
                      : "Shared by you"}{" "}
                    → {recipientName(share)}
                  </small>
                </header>
                <p>
                  {share.mode === "snapshot"
                    ? share.snapshotText
                    : `This live reference resolves ${share.source.kind} ${share.source.id} under the current account on each deliberate use. It can become unavailable and conveys no tool authority.`}
                </p>
                <small>
                  {share.source.kind} · source revision {share.sourceRevision} ·{" "}
                  {new Date(share.createdAt).toLocaleDateString()}
                </small>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void perform(() => onRemoveShare(share.id))}
                >
                  Stop sharing
                </button>
              </article>
            ))}
            {project.shares.length === 0 ? (
              <p className="project-files__empty">
                Nothing has been explicitly shared into this project yet.
              </p>
            ) : null}
            <form
              className="project-share__new"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(submitShare);
              }}
            >
              <label>
                Source
                <select
                  name="source"
                  required
                  value={sourceKey}
                  onChange={(event) => {
                    setSourceKey(event.target.value);
                    const next = shareSources.find(
                      (source) => source.key === event.target.value,
                    );
                    setSnapshotDraft(next?.snapshotText ?? "");
                  }}
                >
                  <option value="" disabled>
                    Choose a file, result or conversation
                  </option>
                  {shareSources.map((source) => (
                    <option key={source.key} value={source.key}>
                      {source.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Sharing
                <select
                  name="mode"
                  value={shareMode}
                  onChange={(event) =>
                    setShareMode(event.target.value as ProjectShareMode)
                  }
                >
                  <option value="snapshot">Snapshot — frozen selected bytes</option>
                  <option value="live-reference">
                    Live reference — resolves again under this account
                  </option>
                </select>
              </label>
              <label>
                Recipient
                <select
                  name="recipient"
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                >
                  <option value="project">Whole project</option>
                  {team?.participantIds.map((id) => (
                    <option key={id} value={id}>
                      {runtime.agents.find((agent) => agent.id === id)?.name ??
                        "Removed agent"}
                    </option>
                  ))}
                </select>
              </label>
              {shareMode === "snapshot" ? (
                <label>
                  Snapshot text
                  <textarea
                    name="snapshot"
                    value={snapshotDraft}
                    onChange={(event) => setSnapshotDraft(event.target.value)}
                    rows={3}
                    maxLength={32000}
                    required
                    placeholder="Select the exact text to freeze"
                  />
                </label>
              ) : (
                <p className="team-dialog-note">
                  A live reference copies no bytes; it is re-authorized and
                  resolved when a recipient deliberately uses it.
                </p>
              )}
              <p className="team-dialog-note">
                Sharing records a recipient and owner. It never grants tool or
                computer authority, and a snapshot cannot be changed by later
                source edits.
              </p>
              <button type="submit" disabled={pending || !selectedSource}>
                Share into project
              </button>
            </form>
          </div>
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
          <TeamReadiness
            participantIds={team?.participantIds ?? []}
            agents={runtime.agents}
            models={runtime.modelOptions}
            providers={runtime.backendProviders}
            compact
          />
          <p className="team-dialog-note">
            New participants can read project-shared history and records.
            Removing a participant prevents dispatch and pauses its active work;
            historical authorship remains.
          </p>
        </details>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
