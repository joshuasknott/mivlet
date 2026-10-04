import { useMutation, useQuery } from "@tanstack/react-query";
import {
  inspectNativeExecution,
  setupNativeExecution,
} from "../../runtime/domains/coding";
import "./repository-files.css";

export function NativeExecutionSetup() {
  const status = useQuery({
    queryKey: ["native-execution"],
    queryFn: inspectNativeExecution,
    retry: false,
    gcTime: 0,
  });
  const setup = useMutation({
    mutationFn: setupNativeExecution,
    onSuccess: () => void status.refetch(),
  });
  if (!status.data && !status.error) return null;
  const error = setup.error ?? status.error;
  const ready = status.data?.available;
  return (
    <details className="repository-files" open={!ready}>
      <summary>
        {`Coding and analysis · ${ready ? "ready" : "setup needed"}`}
      </summary>
      <p role={error ? "alert" : undefined}>
        {error?.message ||
          status.data?.message ||
          "Node and Python are included."}
      </p>
      <p>
        Administrator approval is needed for setup only.
      </p>
      <div className="repository-files__actions">
        {[
          ready ? "Repair setup" : "Set up native execution",
          "Remove setup permissions",
          "Check again",
        ].map(
          (label, index) =>
            (ready || index !== 1) && (
              <button
                key={label}
                type="button"
                disabled={status.isFetching || setup.isPending}
                onClick={() =>
                  index === 2
                    ? void status.refetch()
                    : setup.mutate(index === 1)
                }
              >
                {label}
              </button>
            ),
        )}
      </div>
      {setup.isPending && <p role="status">Waiting for Windows setup…</p>}
    </details>
  );
}
