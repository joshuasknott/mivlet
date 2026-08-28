import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  loadRuntimeHostedComputer,
  provisionRuntimeHostedComputer
} from "../runtime";

/** Optional hosted computer state. No background work or scheduler is attached. */
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
      if (!workspaceId || !deviceId) {
        throw new Error("A signed-in hosted workspace and active device are required.");
      }
      return provisionRuntimeHostedComputer(workspaceId, agentId, deviceId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey })
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
    provision: () => provision.mutateAsync()
  };
}
