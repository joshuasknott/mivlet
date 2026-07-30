import { useRef, useState } from "react";
import type {
  RuntimeArtifactBundle,
  RuntimeCitedApproval,
  RuntimeMissionApproval,
  RuntimeMissionHumanInputRequest,
  RuntimeMissionProgress,
  RuntimeThreadMissionProgress,
} from "../../runtime";
import type {
  CitedBriefMissionPlanSummary,
  CitedBriefMissionReceipt,
} from "../../lib/cited-brief-mission";
import type { MissionHumanInputArtifactOption } from "../../components/workspace-cards";

interface ArtifactOptionsState {
  loading: boolean;
  options: MissionHumanInputArtifactOption[];
  error?: string;
}

interface MissionProgressState {
  loading: boolean;
  progress?: RuntimeMissionProgress;
  error?: string;
}

interface MissionReviewState {
  busyCriterion?: string;
  error?: string;
}

/**
 * Owns mission-specific presentation state. Runtime execution and durable
 * mission authority remain outside this hook.
 */
export function useMissionWorkspaceState() {
  const [hydratedMissionReceipts, setHydratedMissionReceipts] = useState<{
    key: string;
    receipts: Record<string, CitedBriefMissionReceipt>;
  }>({ key: "", receipts: {} });
  const [hydratedMissionPlans, setHydratedMissionPlans] = useState<{
    key: string;
    plans: Record<string, CitedBriefMissionPlanSummary>;
  }>({ key: "", plans: {} });
  const [threadArtifacts, setThreadArtifacts] = useState<
    RuntimeArtifactBundle[]
  >([]);
  const [pendingCitedApprovals, setPendingCitedApprovals] = useState<
    RuntimeCitedApproval[]
  >([]);
  const [approvalListWarning, setApprovalListWarning] = useState<string | null>(
    null,
  );
  const [approvalBusyRunId, setApprovalBusyRunId] = useState<string | null>(
    null,
  );
  const [approvalErrors, setApprovalErrors] = useState<Record<string, string>>(
    {},
  );
  const [pendingMissionApprovals, setPendingMissionApprovals] = useState<
    RuntimeMissionApproval[]
  >([]);
  const [missionApprovalListWarning, setMissionApprovalListWarning] = useState<
    string | null
  >(null);
  const [missionApprovalBusyRunId, setMissionApprovalBusyRunId] = useState<
    string | null
  >(null);
  const [missionApprovalErrors, setMissionApprovalErrors] = useState<
    Record<string, string>
  >({});
  const [pendingMissionInputs, setPendingMissionInputs] = useState<
    RuntimeMissionHumanInputRequest[]
  >([]);
  const [missionInputListWarning, setMissionInputListWarning] = useState<
    string | null
  >(null);
  const [missionInputBusyRunId, setMissionInputBusyRunId] = useState<
    string | null
  >(null);
  const [missionInputErrors, setMissionInputErrors] = useState<
    Record<string, string>
  >({});
  const [missionInputArtifactOptions, setMissionInputArtifactOptions] =
    useState<Record<string, ArtifactOptionsState>>({});
  const [pendingMissionProgress, setPendingMissionProgress] = useState<
    Record<string, MissionProgressState>
  >({});
  const [threadMissionProgress, setThreadMissionProgress] = useState<
    RuntimeThreadMissionProgress[]
  >([]);
  const [threadMissionProgressWarning, setThreadMissionProgressWarning] =
    useState<string | null>(null);
  const [missionReviewState, setMissionReviewState] = useState<
    Record<string, MissionReviewState>
  >({});
  const [parallelMissionRunning, setParallelMissionRunning] = useState(false);
  const parallelMissionCancellationRef = useRef<(() => Promise<void>) | null>(
    null,
  );
  const [generalMissionRunning, setGeneralMissionRunning] = useState(false);
  const generalMissionCancellationRef = useRef<(() => Promise<void>) | null>(
    null,
  );

  return {
    hydratedMissionReceipts,
    setHydratedMissionReceipts,
    hydratedMissionPlans,
    setHydratedMissionPlans,
    threadArtifacts,
    setThreadArtifacts,
    pendingCitedApprovals,
    setPendingCitedApprovals,
    approvalListWarning,
    setApprovalListWarning,
    approvalBusyRunId,
    setApprovalBusyRunId,
    approvalErrors,
    setApprovalErrors,
    pendingMissionApprovals,
    setPendingMissionApprovals,
    missionApprovalListWarning,
    setMissionApprovalListWarning,
    missionApprovalBusyRunId,
    setMissionApprovalBusyRunId,
    missionApprovalErrors,
    setMissionApprovalErrors,
    pendingMissionInputs,
    setPendingMissionInputs,
    missionInputListWarning,
    setMissionInputListWarning,
    missionInputBusyRunId,
    setMissionInputBusyRunId,
    missionInputErrors,
    setMissionInputErrors,
    missionInputArtifactOptions,
    setMissionInputArtifactOptions,
    pendingMissionProgress,
    setPendingMissionProgress,
    threadMissionProgress,
    setThreadMissionProgress,
    threadMissionProgressWarning,
    setThreadMissionProgressWarning,
    missionReviewState,
    setMissionReviewState,
    parallelMissionRunning,
    setParallelMissionRunning,
    parallelMissionCancellationRef,
    generalMissionRunning,
    setGeneralMissionRunning,
    generalMissionCancellationRef,
  };
}
