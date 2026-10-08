import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SettingsRuntime } from "./settings-runtime";
import type { LocalSchedule } from "../../runtime/domains/local-schedules";
import { setLocalScheduleStatus } from "../../runtime/domains/local-schedules";
import {
  configureEventIngress,
  getEventIngress,
  listEventDeliveries,
} from "../../runtime/domains/event-automations";
import { EventAutomationEditor } from "./EventAutomationEditor";
import "./event-automations.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Event automations are unavailable.";
type Props = {
  runtime: SettingsRuntime;
  workspaceId: string;
  schedules: LocalSchedule[];
  initialAgentId?: string;
  onOpenResult?: (agentId: string, threadId: string) => Promise<void>;
};

export function EventAutomations({
  runtime,
  workspaceId,
  schedules,
  initialAgentId,
  onOpenResult,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LocalSchedule | null | undefined>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [port, setPort] = useState<string>();
  const client = useQueryClient();
  const ingress = useQuery({
    queryKey: ["event-ingress", workspaceId],
    queryFn: () => getEventIngress(workspaceId),
    enabled: open,
    retry: false,
    refetchInterval: open ? 15_000 : false,
  });
  const selectedPort = port ?? String(ingress.data?.port ?? 24138);
  const events = schedules.filter(
    (schedule) =>
      schedule.trigger.kind === "event" &&
      schedule.status !== "cancelled" &&
      (!initialAgentId || schedule.agentId === initialAgentId),
  );
  const act = async (operation: () => Promise<unknown>, done: string) => {
    setPending(true);
    setStatus("");
    try {
      await operation();
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["local-schedules", workspaceId],
        }),
        client.invalidateQueries({ queryKey: ["event-ingress", workspaceId] }),
      ]);
      setStatus(done);
    } catch (error) {
      setStatus(message(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <details
      className="event-automations"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Event triggers <span>{events.length || ""}</span>
      </summary>
      {open ? (
        <div className="event-automations__body">
          <p>
            Start a saved task when an authenticated event arrives. Runs use the
            agent’s current tools, saved permission ceiling, ordinary approvals
            and Stop.
          </p>
          <div className="event-automations__ingress">
            <strong>
              {ingress.data?.listening
                ? "Local ingress is listening"
                : "Local ingress is off"}
            </strong>
            <p>
              Mivlet must be open, signed in and awake. Public delivery needs
              your own HTTPS tunnel to this local listener. No events are held
              in the cloud; retry missed deliveries at their source.
            </p>
            {ingress.data?.baseUrl ? <code>{ingress.data.baseUrl}</code> : null}
            {ingress.data?.prerequisite ? (
              <p role="alert">{ingress.data.prerequisite}</p>
            ) : null}
            {ingress.error ? (
              <p role="alert">{message(ingress.error)}</p>
            ) : null}
            <label>
              Local port
              <input
                className="input"
                type="number"
                min={1024}
                max={65535}
                value={selectedPort}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="button button--secondary"
              disabled={
                pending ||
                ingress.isPending ||
                !!ingress.error ||
                !Number.isInteger(Number(selectedPort)) ||
                Number(selectedPort) < 1024 ||
                Number(selectedPort) > 65535
              }
              onClick={() =>
                void act(
                  () =>
                    configureEventIngress({
                      workspaceId,
                      enabled: !ingress.data?.listening,
                      port: ingress.data?.listening
                        ? ingress.data.port
                        : Number(selectedPort),
                    }),
                  ingress.data?.listening
                    ? "Local event ingress stopped."
                    : "Local event ingress enabled for this account.",
                )
              }
            >
              {ingress.data?.listening
                ? "Stop local ingress"
                : "Enable local ingress"}
            </button>
          </div>
          <button
            type="button"
            className="button button--secondary"
            disabled={pending || editing !== undefined}
            onClick={() => setEditing(null)}
          >
            New event trigger
          </button>
          {editing !== undefined ? (
            <EventAutomationEditor
              key={editing?.id ?? "new-event"}
              runtime={runtime}
              workspaceId={workspaceId}
              schedule={editing}
              initialAgentId={initialAgentId}
              onClose={() => setEditing(undefined)}
              onSaved={() => {
                setEditing(undefined);
                void client.invalidateQueries({
                  queryKey: ["local-schedules", workspaceId],
                });
              }}
            />
          ) : null}
          {events.length === 0 && editing === undefined ? (
            <p>No event triggers configured.</p>
          ) : null}
          {events.map((schedule) =>
            schedule.trigger.kind === "event" ? (
              <article className="event-automations__trigger" key={schedule.id}>
                <strong>
                  {runtime.agents.find((agent) => agent.id === schedule.agentId)
                    ?.name ?? "Unavailable agent"}{" "}
                  · {schedule.status === "enabled" ? "Enabled" : "Paused"}
                </strong>
                <p>{schedule.prompt}</p>
                <small>
                  {schedule.trigger.source.kind === "signed-json"
                    ? schedule.trigger.source.sourceId
                    : `${schedule.trigger.source.repository} · ${schedule.trigger.source.kind === "github-issues" ? "Issues" : "Workflow runs"}`}
                </small>
                <small>
                  Expires{" "}
                  {new Date(schedule.trigger.validUntil).toLocaleString()} ·
                  Ignore events older than{" "}
                  {Math.round(schedule.trigger.maxAgeSeconds / 60)} minutes
                </small>
                <label>
                  Endpoint path
                  <input
                    className="input"
                    readOnly
                    value={`${ingress.data?.baseUrl ?? ""}/events/${schedule.id}/${schedule.trigger.routeId}`}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <div className="profile-action-row">
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={pending || editing !== undefined}
                    onClick={() => setEditing(schedule)}
                  >
                    Edit event trigger
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={pending}
                    onClick={() =>
                      void act(
                        () =>
                          setLocalScheduleStatus({
                            workspaceId,
                            id: schedule.id,
                            expectedRevision: schedule.revision,
                            status:
                              schedule.status === "enabled"
                                ? "paused"
                                : "enabled",
                          }),
                        schedule.status === "enabled"
                          ? "Trigger paused. Pending events will not replay on resume."
                          : "Trigger enabled for fresh events.",
                      )
                    }
                  >
                    {schedule.status === "enabled"
                      ? "Pause trigger"
                      : "Enable trigger"}
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={pending}
                    onClick={() =>
                      void act(
                        () =>
                          setLocalScheduleStatus({
                            workspaceId,
                            id: schedule.id,
                            expectedRevision: schedule.revision,
                            status: "cancelled",
                          }),
                        "Trigger removed. Its old endpoint cannot start work.",
                      )
                    }
                  >
                    Remove trigger
                  </button>
                </div>
                <EventDeliveryHistory
                  workspaceId={workspaceId}
                  schedule={schedule}
                  onOpenResult={onOpenResult}
                />
              </article>
            ) : null,
          )}
          {status ? <p role="status">{status}</p> : null}
        </div>
      ) : null}
    </details>
  );
}

function EventDeliveryHistory({
  workspaceId,
  schedule,
  onOpenResult,
}: Pick<Props, "workspaceId" | "onOpenResult"> & { schedule: LocalSchedule }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const history = useQuery({
    queryKey: ["event-deliveries", workspaceId, schedule.id],
    queryFn: () => listEventDeliveries(workspaceId, schedule.id),
    enabled: open,
    retry: false,
    refetchInterval: open ? 15_000 : false,
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Delivery history</summary>
      <p>
        Selected fields and the produced request are redacted. Raw requests,
        headers and signing secrets are never saved. The latest 50 deliveries
        are shown; replay receipts remain for seven days.
      </p>
      {history.isPending && open ? (
        <p role="status">Loading deliveries…</p>
      ) : null}
      {history.error ? <p role="alert">{message(history.error)}</p> : null}
      {history.data?.length === 0 ? <p>No deliveries received.</p> : null}
      {history.data?.map((delivery) => (
        <article className="event-automations__delivery" key={delivery.id}>
          <strong>{delivery.state}</strong>
          <small>
            <time dateTime={delivery.receivedAt}>
              {new Date(delivery.receivedAt).toLocaleString()}
            </time>
          </small>
          <p>{delivery.reason}</p>
          {delivery.prompt ? (
            <details>
              <summary>Produced request and selected fields</summary>
              <pre>{delivery.prompt}</pre>
              <pre>{JSON.stringify(delivery.selectedFields, null, 2)}</pre>
            </details>
          ) : null}
          {delivery.threadId && onOpenResult ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() =>
                void onOpenResult(schedule.agentId, delivery.threadId!).catch(
                  (failure) => setError(message(failure)),
                )
              }
            >
              Open event work
            </button>
          ) : null}
        </article>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
