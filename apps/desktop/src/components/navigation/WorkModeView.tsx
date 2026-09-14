import { lazy, Suspense, useState } from "react";
import type {
  ApprovalRequest,
  CollaborationWorkItem,
  FableAgentProfile,
  LocalProject,
  WorkOutput,
} from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import type { WorkspaceExecution } from "../../lib/workspace-execution";
import { useLocalComputer } from "../../hooks/useLocalComputer";
import { WorkList } from "../work/WorkCard";
import { WorkDetails } from "../work/WorkDetails";
import "../work/work.css";
import "./navigation.css";
import { NativeComputerPanel } from "../agents/NativeComputerPanel";
import { parseComputerArtifact } from "../../lib/computer-artifacts";
import { attentionOrder } from "./work-order";

const ApprovalPanel = lazy(() =>
  import("../ApprovalPanel").then((module) => ({
    default: module.ApprovalPanel,
  })),
);

function ComputerSummary({
  agent,
  workspaceId,
  onOpenComputer,
}: {
  agent: FableAgentProfile;
  workspaceId: string;
  onOpenComputer: (agentId: string) => void;
}) {
  const computer = useLocalComputer({
    workspaceId,
    agentId: agent.id,
    executionOwner: false,
  });
  return (
    <div className="work-mode__computer">
      <NativeComputerPanel agentName={agent.name} computer={computer} />
      <button type="button" onClick={() => onOpenComputer(agent.id)}>
        Open the full computer view
      </button>
    </div>
  );
}

/**
 * The Work mode of the selected Agent or Project. It only presents existing
 * state through owned services: progress, produced files, waiting approvals,
 * connected tools and the agent computer. Nothing here dispatches work.
 */
export function WorkModeView({
  project,
  agent,
  work,
  runtime,
  service,
  approvals,
  selectedWork,
  onOpen,
  onOpenWork,
  onStopWork,
  onContinueWork,
  onSteerWork,
  onPromoteWorkOutput,
  onOpenArtifact,
  onOpenComputer,
  onSchedules,
  onOpenPlugins,
}: {
  project?: LocalProject;
  agent?: FableAgentProfile;
  work: CollaborationWorkItem[];
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  approvals: ApprovalRequest[];
  selectedWork?: CollaborationWorkItem;
  onOpen: (id: string, newTab?: boolean) => void;
  onOpenWork: (id: string | null) => void;
  onStopWork: (id: string) => void | Promise<void>;
  onContinueWork: (
    id: string,
    expectedGeneration: number,
  ) => void | Promise<void>;
  onSteerWork: (
    id: string,
    expectedGeneration: number,
    text: string,
  ) => void | Promise<void>;
  onPromoteWorkOutput: (
    output: WorkOutput,
    item: CollaborationWorkItem,
    value: string,
  ) => void | Promise<void>;
  onOpenArtifact: (output: string, agentId: string) => void;
  onOpenComputer: (agentId: string) => void;
  onSchedules: () => void;
  onOpenPlugins: () => void;
}) {
  const [showTools, setShowTools] = useState(false);
  const artifacts = work.flatMap((item) =>
    item.outputs.flatMap((output) => {
      const artifact = parseComputerArtifact(output.text);
      return artifact ? [{ item, output, artifact }] : [];
    }),
  );
  const tools = runtime.connectorManifests.filter(
    (connector) => connector.status === "connected" && connector.id !== "local-files",
  );
  return (
    <div className="work-mode" role="region" aria-label="Work">
      <header className="work-mode__header">
        <h1>Work</h1>
        <p>
          {selectedWork
            ? `Selected request for ${selectedWork.agentName}.`
            : project
              ? `Everything ${project.name}'s team is doing.`
              : agent
                ? `Everything ${agent.name} is doing.`
                : "Everything happening in this conversation."}
        </p>
        <div className="work-mode__header-actions">
          <button type="button" onClick={onSchedules}>
            Schedules
          </button>
        </div>
      </header>
      <section aria-label="Progress" className="work-mode__section">
        <h2>Progress</h2>
        {selectedWork ? (
          <div className="work-mode__selected">
            <button
              type="button"
              className="work-mode__back"
              onClick={() => onOpenWork(null)}
            >
              All work
            </button>
            <WorkDetails
              item={selectedWork}
              onOpen={onOpen}
              onStop={onStopWork}
              onContinue={onContinueWork}
              onSteer={onSteerWork}
              onPromote={onPromoteWorkOutput}
            />
          </div>
        ) : null}
        <WorkList
          work={attentionOrder(work)}
          empty="Assignments and their results appear here when work starts."
          onOpen={onOpen}
          onOpenWork={onOpenWork}
          onStop={onStopWork}
          onContinue={onContinueWork}
          onSteer={onSteerWork}
        />
      </section>
      <section aria-label="Files" className="work-mode__section">
        <h2>Files</h2>
        {artifacts.length ? (
          artifacts.map(({ item, output, artifact }) => (
            <button
              key={`${item.id}:${output.runId}`}
              type="button"
              className="work-mode__file"
              onClick={() => onOpenArtifact(output.text, item.agentId)}
              title={artifact.relativePath}
            >
              {artifact.title}
            </button>
          ))
        ) : (
          <p className="work-mode__empty">
            Generated files appear here when work produces them.
          </p>
        )}
      </section>
      <section aria-label="Approvals" className="work-mode__section">
        <h2>Approvals {approvals.length ? `(${approvals.length})` : ""}</h2>
        {approvals.length ? (
          <Suspense fallback={<p role="status">Loading approvals…</p>}>
            <ApprovalPanel
              compact
              previews={runtime.approvalPreviews}
              approvals={approvals}
              audit={runtime.approvalAudit}
              sessionGrants={runtime.sessionApprovalGrants}
              approvalRules={runtime.approvalRules}
              editingApprovalId={
                approvals.some(
                  (approval) => approval.id === runtime.editingApprovalId,
                )
                  ? runtime.editingApprovalId
                  : null
              }
              modificationDraft={runtime.approvalModificationDraft}
              pendingConfirmation={
                runtime.pendingApprovalConfirmation &&
                approvals.some(
                  (approval) =>
                    approval.id ===
                    runtime.pendingApprovalConfirmation?.request.id,
                )
                  ? runtime.pendingApprovalConfirmation
                  : null
              }
              confirmationText={runtime.approvalConfirmationText}
              onDecision={runtime.requestApprovalDecision}
              onStartModify={runtime.startApprovalModify}
              onUpdateModification={runtime.setApprovalModificationDraft}
              onSaveModify={runtime.saveApprovalModify}
              onCancelModify={runtime.clearApprovalInteraction}
              onUpdateConfirmation={runtime.setApprovalConfirmationText}
              onConfirmDecision={runtime.confirmApprovalDecision}
              onCancelConfirmation={runtime.clearApprovalInteraction}
            />
          </Suspense>
        ) : (
          <p className="work-mode__empty">
            No approvals are waiting for this conversation.
          </p>
        )}
      </section>
      <section aria-label="Tools" className="work-mode__section">
        <h2>
          <button
            type="button"
            aria-expanded={showTools}
            onClick={() => setShowTools(!showTools)}
          >
            Tools
          </button>
        </h2>
        {showTools ? (
          <div className="work-mode__tools">
            {tools.length ? (
              tools.map((connector) => (
                <p key={connector.id}>{connector.name}</p>
              ))
            ) : (
              <p className="work-mode__empty">No connected apps yet.</p>
            )}
            <button type="button" onClick={onOpenPlugins}>
              Open Plugins
            </button>
          </div>
        ) : null}
      </section>
      {agent ? (
        <section aria-label="Computer" className="work-mode__section">
          <h2>Computer</h2>
          <ComputerSummary
            agent={agent}
            workspaceId={service.workspaceId}
            onOpenComputer={onOpenComputer}
          />
        </section>
      ) : null}
    </div>
  );
}
