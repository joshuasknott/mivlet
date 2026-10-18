import { useState } from "react";
import type {
  CollaborationWorkItem,
  MemoryRecord,
  MivletAgentProfile,
} from "@mivlet/protocol";
import { BookmarkSimple } from "@phosphor-icons/react/dist/csr/BookmarkSimple";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { workPresentation } from "../work/WorkStatusBadge";
import { displayWorkspaceMentions } from "../../lib/collaboration-mentions";
import type { PanelPage, RightPanelTab } from "./right-panel-state";
import { PanelFileRow } from "./PanelFileRow";
import type { PanelFile } from "./workspace-panel-data";

export function WorkspaceActivity({
  workspaceId,
  work,
  agents,
  files,
  memories,
  memoryDisabled,
  onInspect,
  onStop,
  onOpen,
  onNavigate,
}: {
  workspaceId: string;
  work: CollaborationWorkItem[];
  agents: MivletAgentProfile[];
  files: PanelFile[];
  memories: { record: MemoryRecord; group: string }[];
  memoryDisabled: boolean;
  onInspect: (id: string | null) => void;
  onStop: (id: string) => Promise<void>;
  onOpen: (tab: RightPanelTab) => void;
  onNavigate: (page: PanelPage) => void;
}) {
  const active = work
    .filter(
      (item) =>
        !["completed", "cancelled", "failed"].includes(item.status) ||
        item.awaitingUser,
    )
    .sort(
      (a, b) =>
        Number(
          b.awaitingUser ||
            b.status === "awaiting-approval" ||
            b.status === "awaiting-user",
        ) -
          Number(
            a.awaitingUser ||
              a.status === "awaiting-approval" ||
              a.status === "awaiting-user",
          ) || b.updatedAt.localeCompare(a.updatedAt),
    );
  const sharedFiles = files.filter((file) => file.origin !== "created");
  const saved = memories.filter(
    ({ record }) =>
      record.approved &&
      !record.disabled &&
      record.approvalState !== "suggested",
  );
  const recent = files.filter((file) => file.origin === "created");
  const completed = work
    .filter((item) => item.status === "completed" && !item.awaitingUser)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latest = !active.length ? completed[0] : undefined;
  const latestAgent = latest ? agents.find((agent) => agent.id === latest.agentId) : undefined;
  const latestFile = latest
    ? recent.find(
        (file) =>
          file.tab?.kind === "artifact" &&
          file.tab.agentId === latest.agentId &&
          latest.outputs?.some(
            (output) =>
              output.text ===
              (file.tab?.kind === "artifact" ? file.tab.output : undefined),
          ),
      )
    : undefined;
  return (
    <div className="workspace-activity">
      {(!latest || active.length > 0) && (
        <section className="workspace-activity__section" aria-label="Work now">
          <h3>Work now</h3>
          {active.slice(0, 4).map((item) => {
            const agent = agents.find((agent) => agent.id === item.agentId);
            const attention =
              item.awaitingUser ||
              ["awaiting-user", "awaiting-approval", "blocked"].includes(
                item.status,
              );
            const status = workPresentation(item);
            return (
              <div className="workspace-activity__work" key={item.id}>
                {agent ? (
                  <ProfileAgentAvatar agent={agent} iconSize={30} />
                ) : null}
                <button
                  type="button"
                  className="workspace-activity__assignment"
                  onClick={() => {
                    onInspect(item.id);
                    onNavigate("history");
                  }}
                >
                  <strong>
                    {displayWorkspaceMentions(item.prompt || item.userRequest)}
                  </strong>
                  <small>
                    {item.agentName} · {status.detail ?? status.label}
                  </small>
                </button>
                {attention ? (
                  <button
                    className="workspace-activity__action"
                    type="button"
                    onClick={() => {
                      onInspect(item.id);
                      onNavigate("history");
                    }}
                  >
                    Review
                  </button>
                ) : (
                  <StopAssignment id={item.id} onStop={onStop} />
                )}
              </div>
            );
          })}
          {!active.length && (
            <p className="workspace-activity__quiet">Nothing in progress.</p>
          )}
          <button
            type="button"
            className="workspace-panel__link"
            onClick={() => {
              onInspect(null);
              onNavigate("history");
            }}
          >
            {active.length > 4
              ? "View all " + active.length + " active assignments"
              : "View work history"}
          </button>
        </section>
      )}
      {latest && (
        <section
          className="workspace-activity__section"
          aria-label="Latest completed work"
        >
          <h3>Latest work</h3>
          <div className="workspace-activity__latest">
            <div className="workspace-activity__latest-heading">
              <CheckCircle size={24} aria-hidden="true" />
              <div>
                <strong>
                  {displayWorkspaceMentions(
                    latest.prompt || latest.userRequest,
                  )}
                </strong>
                <small className="workspace-activity__author">{latestAgent && <ProfileAgentAvatar agent={latestAgent} iconSize={18} />}{latest.agentName} · Completed</small>
              </div>
            </div>
            <button
              type="button"
              className="workspace-activity__open"
              onClick={() => {
                if (latestFile?.tab) onOpen(latestFile.tab);
                else {
                  onInspect(latest.id);
                  onNavigate("history");
                }
              }}
            >
              {latestFile ? "Open " + latestFile.title : "View result"}
            </button>
          </div>
        </section>
      )}
      {!active.length && completed.length > 1 && (
        <section
          className="workspace-activity__section"
          aria-label="Recent activity"
        >
          <h3>Recent activity</h3>
          <ol className="workspace-activity__timeline">
            {completed.slice(1, 4).map((item) => (
              <li key={item.id}>
                <CheckCircle size={19} aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => {
                    onInspect(item.id);
                    onNavigate("history");
                  }}
                >
                  {displayWorkspaceMentions(item.prompt || item.userRequest)}
                </button>
                <small>{item.agentName} · Completed</small>
              </li>
            ))}
          </ol>
        </section>
      )}
      {(sharedFiles.length > 0 || saved.length > 0) && (
        <section
          className="workspace-activity__section"
          aria-label="Shared with agent"
        >
          <h3>Shared with agent</h3>
          {sharedFiles.slice(0, 1).map((file) => (
            <PanelFileRow
              key={file.id}
              file={file}
              workspaceId={workspaceId}
              onOpen={onOpen}
            />
          ))}
          {saved.slice(0, 1).map(({ record, group }) => (
            <button
              key={record.id}
              type="button"
              className="workspace-library__card"
              onClick={() => onNavigate("memory")}
            >
              <BookmarkSimple size={21} aria-hidden="true" />
              <span className="workspace-library__detail">
                <strong>{record.title}</strong>
                <small>{memoryDisabled ? "Memory paused" : group}</small>
              </span>
            </button>
          ))}
          <button
            type="button"
            className="workspace-panel__link"
            onClick={() => onNavigate(sharedFiles.length ? "files" : "memory")}
          >
            View shared items
          </button>
        </section>
      )}
      {recent.length > 0 && (
        <details
          className="workspace-activity__section workspace-library__technical"
          aria-label="Recent files"
        >
          <summary>Recent files <span>({recent.length})</span></summary>
          {recent.slice(0, 2).map((file) => (
            <PanelFileRow
              key={file.id}
              file={file}
              workspaceId={workspaceId}
              onOpen={onOpen}
            />
          ))}
          <button
            type="button"
            className="workspace-panel__link"
            onClick={() => onNavigate("files")}
          >
            View all files
          </button>
        </details>
      )}
      {latest && <button type="button" className="workspace-panel__link" onClick={() => { onInspect(null); onNavigate("history"); }}>View work history</button>}
    </div>
  );
}

function StopAssignment({
  id,
  onStop,
}: {
  id: string;
  onStop: (id: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="workspace-activity__stop">
      <button
        type="button"
        className="workspace-activity__action"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          try {
            await onStop(id);
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Could not stop this assignment.",
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Stopping…" : "Stop"}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
