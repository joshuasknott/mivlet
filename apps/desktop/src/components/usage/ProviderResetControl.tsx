import { useEffect, useState } from "react";
import type {
  CollaborationCommand,
  CollaborationSnapshot,
  CollaborationWorkItem,
  ProviderAllowance,
} from "@mivlet/protocol";
import { commandCollaboration } from "../../runtime/domains/collaboration";
import {
  currentAllowance,
  readProviderAllowance,
  refreshProviderAllowance,
} from "../../runtime/domains/provider-usage";
import "./provider-usage.css";

/** Native typed failure evidence is verified at arm time; text is never parsed for quota. */
export function ProviderResetControl({
  item,
  onCommand,
}: {
  item: CollaborationWorkItem;
  onCommand?: (command: CollaborationCommand) => Promise<CollaborationSnapshot>;
}) {
  const providerId = item.modelOptionId.split("::")[0];
  const [report, setReport] = useState<ProviderAllowance | null>(null);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState(item.resetContinuation);
  useEffect(() => {
    let current = true;
    setReport(null);
    setChecked(false);
    setChoice(item.resetContinuation);
    if (providerId)
      void readProviderAllowance(providerId)
        .then((value) => {
          if (current) setReport(value);
        })
        .catch(() => {
          if (current) setReport(null);
        });
    return () => {
      current = false;
    };
  }, [item.id, item.generation, item.resetContinuation, providerId]);
  if (
    !["failed", "awaiting-user", "cancelled"].includes(item.status) ||
    !item.runIds.length
  )
    return null;
  const measured = currentAllowance(report);
  const opportunity =
    measured?.status === "available" &&
    measured.resetOpportunity?.id !== choice?.opportunityId
      ? measured.resetOpportunity
      : undefined;
  const action = async (cancel: boolean) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const command: CollaborationCommand = cancel
        ? {
            action: "cancel-provider-reset",
            id: item.id,
            expectedGeneration: item.generation,
          }
        : {
            action: "arm-provider-reset",
            id: item.id,
            expectedGeneration: item.generation,
            opportunityId: opportunity!.id,
            reconcile: true,
          };
      const result = await (onCommand
        ? onCommand(command)
        : commandCollaboration(item.workspaceId, command));
      setChoice(
        result.work.find((work) => work.id === item.id)?.resetContinuation,
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The reset continuation could not be saved.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="provider-reset-control">
      {choice?.state === "armed" ? (
        <>
          <p>
            One continuation requested after{" "}
            {new Date(choice.resetsAt).toLocaleString()}. Mivlet must remain
            open; the provider reset and current Work authority will be checked
            first.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void action(true)}
          >
            Cancel reset continuation
          </button>
        </>
      ) : (
        <>
          {choice?.reason ? <p>{choice.reason}</p> : null}
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError("");
              try {
                setReport(await refreshProviderAllowance(providerId));
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Allowance is unavailable.",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            Check provider reset
          </button>
          {opportunity && item.status !== "cancelled" ? (
            <>
              <p>
                The exhausted allowance resets at{" "}
                {new Date(opportunity.resetsAt).toLocaleString()}. Only runs
                with native provider-reported limit evidence can use this
                control.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                />{" "}
                I reviewed the saved results and reconciled any external
                effects.
              </label>
              <button
                type="button"
                disabled={!checked || pending}
                onClick={() => void action(false)}
              >
                Continue once after verified reset
              </button>
            </>
          ) : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
