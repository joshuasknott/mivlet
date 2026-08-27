import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  inspectRuntimeHostedProcess,
  listRuntimeHostedAgentRoutineRuns,
  listRuntimeHostedAgentRoutines,
  listRuntimeHostedProcessScheduleRuns,
  listRuntimeHostedProcessSchedules,
  loadRuntimeHostedComputer,
  provisionRuntimeHostedComputer
} from "../runtime";

export function useHostedComputer({
  workspaceId,
  agentId,
  deviceId
}: {
  workspaceId: string | null;
  agentId: string;
  deviceId: string | null;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["hosted-computer", workspaceId ?? "unavailable", agentId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => loadRuntimeHostedComputer(workspaceId!, agentId),
    enabled: Boolean(workspaceId),
    networkMode: "always",
    retry: 1,
    refetchInterval: (state) => state.state.data?.status === "provisioning" ? 2_000 : false
  });
  const provision = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !deviceId) throw new Error("A signed-in hosted workspace and active device are required.");
      return provisionRuntimeHostedComputer(workspaceId, agentId, deviceId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey })
  });
  const schedulesQuery = useQuery({
    queryKey: ["hosted-computer-schedules", workspaceId ?? "unavailable", agentId, deviceId ?? "unavailable"],
    queryFn: () => listRuntimeHostedProcessSchedules({
      workspaceId: workspaceId!,
      agentId,
      deviceId: deviceId!
    }),
    enabled: Boolean(
      workspaceId
      && deviceId
      && query.data?.status === "ready"
      && query.data.keepAlive
    ),
    networkMode: "always",
    retry: 1,
    refetchInterval: 15_000
  });
  const scheduleRunsQuery = useQuery({
    queryKey: ["hosted-computer-schedule-runs", workspaceId ?? "unavailable", agentId, deviceId ?? "unavailable"],
    queryFn: () => listRuntimeHostedProcessScheduleRuns({
      workspaceId: workspaceId!,
      agentId,
      deviceId: deviceId!
    }),
    enabled: Boolean(
      workspaceId
      && deviceId
      && query.data?.status === "ready"
      && query.data.keepAlive
    ),
    networkMode: "always",
    retry: 1,
    refetchInterval: 15_000
  });
  const agentRoutinesQuery = useQuery({
    queryKey: ["hosted-agent-routines", workspaceId ?? "unavailable", agentId, deviceId ?? "unavailable"],
    queryFn: () => listRuntimeHostedAgentRoutines({ workspaceId: workspaceId!, agentId, deviceId: deviceId! }),
    enabled: Boolean(workspaceId && deviceId && query.data?.status === "ready" && query.data.keepAlive),
    networkMode: "always",
    retry: 1,
    refetchInterval: 15_000
  });
  const agentRoutineRunsQuery = useQuery({
    queryKey: ["hosted-agent-routine-runs", workspaceId ?? "unavailable", agentId, deviceId ?? "unavailable"],
    queryFn: () => listRuntimeHostedAgentRoutineRuns({ workspaceId: workspaceId!, agentId, deviceId: deviceId! }),
    enabled: Boolean(workspaceId && deviceId && query.data?.status === "ready" && query.data.keepAlive),
    networkMode: "always",
    retry: 1,
    refetchInterval: 15_000
  });
  return {
    scopeKey: `${workspaceId ?? "local"}:${agentId}:${deviceId ?? "unavailable"}`,
    node: query.data ?? null,
    loading: query.isPending && Boolean(workspaceId),
    error: provision.error instanceof Error
      ? provision.error.message
      : query.error instanceof Error ? query.error.message : null,
    provisioning: provision.isPending || query.data?.status === "provisioning",
    available: Boolean(workspaceId && deviceId),
    schedules: schedulesQuery.data ?? [],
    schedulesLoading: schedulesQuery.isPending && schedulesQuery.fetchStatus === "fetching",
    schedulesRefreshing: schedulesQuery.isFetching && !schedulesQuery.isPending,
    schedulesError: schedulesQuery.error instanceof Error ? schedulesQuery.error.message : null,
    scheduleRuns: scheduleRunsQuery.data ?? [],
    scheduleRunsLoading: scheduleRunsQuery.isPending && scheduleRunsQuery.fetchStatus === "fetching",
    scheduleRunsError: scheduleRunsQuery.error instanceof Error ? scheduleRunsQuery.error.message : null,
    agentRoutines: agentRoutinesQuery.data ?? [],
    agentRoutinesLoading: agentRoutinesQuery.isPending && agentRoutinesQuery.fetchStatus === "fetching",
    agentRoutinesError: agentRoutinesQuery.error instanceof Error ? agentRoutinesQuery.error.message : null,
    agentRoutineRuns: agentRoutineRunsQuery.data ?? [],
    agentRoutineRunsLoading: agentRoutineRunsQuery.isPending && agentRoutineRunsQuery.fetchStatus === "fetching",
    agentRoutineRunsError: agentRoutineRunsQuery.error instanceof Error ? agentRoutineRunsQuery.error.message : null,
    refreshSchedules: () => Promise.all([
      schedulesQuery.refetch(),
      scheduleRunsQuery.refetch(),
      agentRoutinesQuery.refetch(),
      agentRoutineRunsQuery.refetch()
    ]),
    inspectScheduleRun: async (processId: string) => {
      if (!workspaceId || !deviceId) throw new Error("The hosted computer is unavailable.");
      const snapshot = await inspectRuntimeHostedProcess({ workspaceId, agentId, deviceId, processId });
      if (!snapshot || snapshot.processId !== processId) throw new Error("That cloud run output is unavailable.");
      return snapshot;
    },
    provision: provision.mutate
  };
}
