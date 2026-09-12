import { lazy, Suspense, useEffect, useId, useRef } from "react";
import type { ShellRuntime } from "../hooks/useShellRuntime";
import { useLocalComputer } from "../hooks/useLocalComputer";
import { useHostedComputer } from "../hooks/useHostedComputer";
import { useHostedBrowserController } from "../hooks/useHostedBrowserController";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { LiveWorkRail } from "../components/agents/LiveWorkRail";

const ApprovalPanel = lazy(() =>
  import("../components/ApprovalPanel").then((module) => ({
    default: module.ApprovalPanel,
  })),
);

/** Inspection owns only its manual requests. Closing it never stops an execution. */
export function ComputerInspector({
  agentId,
  runtime,
  service,
  onClose,
}: {
  agentId: string;
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  onClose: () => void;
}) {
  const key = useId();
  const ids = useRef(new Set<string>());
  const gate = service.approvals.acquire(`inspector:${key}`);
  const local = useLocalComputer({
    workspaceId: service.workspaceId,
    agentId,
    executionOwner: false,
  });
  const workspace =
    runtime.accountWorkspaceStatus.workspaces.find(
      (workspace) =>
        workspace.workspaceStatus === "active" &&
        workspace.membershipStatus === "active",
    )?.fableWorkspaceId ?? null;
  const device =
    runtime.accountWorkspaceStatus.devices.find(
      (device) => device.status === "active",
    )?.deviceId ?? null;
  const hosted = useHostedComputer({
    workspaceId: workspace,
    agentId,
    deviceId: device,
  });
  const browser = useHostedBrowserController({
    hostedWorkspaceId: workspace,
    activeHostedDeviceId: device,
    activeAgentId: agentId,
    hostedComputer: hosted,
    approvalGate: gate,
    queueToolApproval: (event) => {
      if (gate.register(event.approval)) {
        ids.current.add(event.approval.id);
        runtime.recordBackendToolCall(event);
      }
    },
  });
  useEffect(
    () => () => {
      service.approvals.release(`inspector:${key}`);
      runtime.clearBackendToolApprovals([...ids.current]);
    },
    [key, service],
  );
  const approvals = runtime.openApprovals.filter((approval) =>
    ids.current.has(approval.id),
  );
  return (
    <div className="computer-inspector">
      <LiveWorkRail
        agentName={
          runtime.agents.find((agent) => agent.id === agentId)?.name ??
          "Removed agent"
        }
        localComputer={local}
        hostedComputer={{
          available: hosted.available,
          status: hosted.node?.status,
          runtimeActive: hosted.node?.runtimeActive ?? false,
          keepAlive: hosted.node?.keepAlive ?? false,
          loading: hosted.loading,
          provisioning: hosted.provisioning,
          error: hosted.error,
          onProvision: hosted.provision,
          browserOpening: browser.opening,
          browserPhase: browser.phase,
          browserError: browser.error,
          browserUrl: browser.snapshot?.currentUrl,
          browserTitle: browser.snapshot?.title,
          liveViewUrl: browser.snapshot?.liveViewUrl,
          browserDownload: browser.snapshot?.lastDownload,
          onOpenBrowser: browser.open,
          onRefreshBrowser: browser.refresh,
        }}
        screenPreviewUrl={browser.snapshot?.previewDataUrl}
        onClose={onClose}
      />
      {approvals.length ? (
        <Suspense fallback={null}>
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
      ) : null}
    </div>
  );
}
