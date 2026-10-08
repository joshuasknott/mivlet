import { useEffect, useRef, useState } from "react";
import type {
  McpClientAccess,
  McpConsentRequest,
  McpServerStatus,
} from "@mivlet/protocol/domains/mcp-server";
import {
  decideMcpClient,
  getMcpServerStatus,
  revokeMcpClient,
  startMcpServer,
  stopMcpServer,
} from "../../runtime/domains/mcp-server";
import "./mcp-server-settings.css";

type Agent = { id: string; name: string };
export function McpServerSettings({
  workspaceId,
  agents,
}: {
  workspaceId: string;
  agents: Agent[];
}) {
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  const [message, setMessage] = useState("");
  const [statusError, setStatusError] = useState("");
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const [port, setPort] = useState("39440");
  const [origin, setOrigin] = useState("");
  const [browserOrigins, setBrowserOrigins] = useState("");
  const refresh = async () => {
    try {
      setStatus(await getMcpServerStatus());
      setStatusError("");
    } catch (error) {
      setStatusError(
        error instanceof Error ? error.message : "MCP status unavailable.",
      );
      throw error;
    }
  };
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await getMcpServerStatus();
        if (active) {
          setStatus(next);
          setStatusError("");
        }
      } catch (error) {
        if (active)
          setStatusError(
            error instanceof Error ? error.message : "MCP status unavailable.",
          );
      } finally {
        if (active) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId]);
  const act = async (action: () => Promise<void>, success: string) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refresh();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MCP action failed.");
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mcp-settings" aria-busy={busy}>
      <p>
        Connect an external assistant to selected agents and Work. New clients
        start with read-only access. Keep Mivlet open and signed in for requests
        to run.
      </p>
      {status?.endpoint ? (
        <>
          <label>
            MCP URL
            <input
              readOnly
              value={status.endpoint}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <div className="profile-action-row">
            <button
              className="button button--secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(
                  () => navigator.clipboard.writeText(status.endpoint!),
                  "MCP URL copied.",
                )
              }
            >
              Copy URL
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(
                  stopMcpServer,
                  "Server stopped. Active tasks requested by clients were stopped.",
                )
              }
            >
              Stop server
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () =>
                startMcpServer({
                  port: Number(port),
                  publicOrigin: origin.trim() || undefined,
                  browserOrigins: browserOrigins
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
              "MCP server started. Add its URL to your assistant and sign in.",
            );
          }}
        >
          <label>
            Local port
            <input
              type="number"
              min="1024"
              max="65535"
              required
              disabled={busy}
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          <details>
            <summary>Remote and browser access</summary>
            <p>
              Remote clients require your own HTTPS reverse proxy forwarding to
              this loopback port, preserving Host, and disabling access-log
              query strings. Starting this server does not publish an endpoint.
            </p>
            <label>
              Public HTTPS origin
              <input
                type="url"
                disabled={busy}
                placeholder="https://mivlet.example.com"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
              />
            </label>
            <label>
              Allowed browser origins, separated by commas
              <input
                disabled={busy}
                placeholder="https://assistant.example.com"
                value={browserOrigins}
                onChange={(event) => setBrowserOrigins(event.target.value)}
              />
            </label>
          </details>
          <button
            className="button button--secondary"
            disabled={busy || !status || Boolean(statusError)}
            type="submit"
          >
            Start MCP server
          </button>
        </form>
      )}
      {!status && !statusError && <p role="status">Loading client access…</p>}
      {statusError && (
        <p role="alert">
          {statusError} New access is paused until status refreshes.
        </p>
      )}
      {(busy || message) && (
        <p role="status">{busy ? "Processing request…" : message}</p>
      )}
      {status?.pending.map((request) => (
        <Consent
          key={request.id}
          request={request}
          agents={agents}
          status={status}
          busy={busy || Boolean(statusError)}
          onDecide={(approve, agentIds, workIds, access, lifetimeHours) =>
            act(
              () =>
                decideMcpClient({
                  requestId: request.id,
                  workspaceId,
                  approve,
                  agentIds,
                  workIds,
                  access,
                  lifetimeHours,
                }),
              approve ? "Client access approved." : "Sign-in denied.",
            )
          }
        />
      ))}
      {status && (
        <>
          <h3>Client access</h3>
          {!status.grants.length && <p>No clients have access.</p>}
          <ul>
            {status.grants.map((grant) => (
              <li key={grant.id}>
                <strong>{grant.clientName}</strong>
                <span>
                  Returns access to <code>{grant.redirectUri}</code>
                </span>
                <span>
                  {grant.access === "read-only"
                    ? "Read only"
                    : "Task requests · exact tool approvals"}
                </span>
                <span>
                  {grant.agentIds
                    .map(
                      (id) =>
                        agents.find((agent) => agent.id === id)?.name ??
                        "Removed agent",
                    )
                    .join(", ")}{" "}
                  · {grant.workIds.length} shared Work
                </span>
                <span>
                  {grant.revoked
                    ? "Revoked"
                    : `${grant.expiresAt * 1000 <= Date.now() ? "Expired" : "Expires"} ${new Date(grant.expiresAt * 1000).toLocaleString()}`}
                </span>
                {!grant.revoked && (
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => revokeMcpClient(grant.id),
                        "Client access revoked. Its active Work was stopped.",
                      )
                    }
                  >
                    Revoke {grant.clientName}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <details>
            <summary>Access history ({status.history.length})</summary>
            <p>
              The most recent 256 decisions and requests. Prompts and
              credentials are excluded.
            </p>
            <ol>
              {[...status.history].reverse().map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  <time>{new Date(entry.at * 1000).toLocaleString()}</time>
                  <span>
                    {status.grants.find(
                      (grant) => grant.clientId === entry.clientId,
                    )?.clientName ??
                      (entry.clientId === "desktop"
                        ? "You"
                        : `Client ${entry.clientId.slice(0, 12)}`)}
                    : {entry.operation} · {entry.outcome}
                  </span>
                  {entry.target && <code>{entry.target}</code>}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </div>
  );
}

function Consent({
  request,
  agents,
  status,
  busy,
  onDecide,
}: {
  request: McpConsentRequest;
  agents: Agent[];
  status: McpServerStatus;
  busy: boolean;
  onDecide: (
    approve: boolean,
    agents: string[],
    work: string[],
    access: McpClientAccess,
    hours: number,
  ) => Promise<void>;
}) {
  const [agentIds, setAgents] = useState<string[]>([]);
  const [workIds, setWork] = useState<string[]>([]);
  const [access, setAccess] = useState<McpClientAccess>("read-only");
  const [hours, setHours] = useState(8);
  return (
    <form
      className="mcp-consent"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        void onDecide(true, agentIds, workIds, access, hours);
      }}
    >
      <h3>{request.clientName} wants to connect</h3>
      <p>
        Match this code to the sign-in you started:{" "}
        <strong>{request.id}</strong>
      </p>
      <p>
        Returns access to <code>{request.redirectUri}</code>
      </p>
      <fieldset disabled={busy}>
        <legend>Agents this client may see and request</legend>
        {agents.map((agent) => (
          <label className="mcp-choice" key={agent.id}>
            <input
              type="checkbox"
              checked={agentIds.includes(agent.id)}
              onChange={(event) => {
                setAgents(
                  event.target.checked
                    ? [...agentIds, agent.id]
                    : agentIds.filter((id) => id !== agent.id),
                );
                setWork([]);
              }}
            />
            {agent.name}
          </label>
        ))}
      </fieldset>
      <label>
        Access
        <select
          disabled={busy}
          value={access}
          onChange={(event) => setAccess(event.target.value as McpClientAccess)}
        >
          <option value="read-only">Read only</option>
          {request.requestedAccess === "request-tasks" && (
            <option value="request-tasks">
              Request tasks, message and stop own Work
            </option>
          )}
        </select>
      </label>
      {access === "request-tasks" && (
        <p>
          Agents use their configured instructions and memory, and share task
          results with this client. Actions that require your approval still ask
          you.
        </p>
      )}
      <details>
        <summary>Share existing Work (optional)</summary>
        {status.shareableWork
          .filter((work) => agentIds.includes(work.agentId))
          .map((work) => (
            <label className="mcp-choice" key={work.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={workIds.includes(work.id)}
                onChange={(event) =>
                  setWork(
                    event.target.checked
                      ? [...workIds, work.id]
                      : workIds.filter((id) => id !== work.id),
                  )
                }
              />
              {work.agentName}: {work.request.slice(0, 100)} ({work.status})
            </label>
          ))}
        <p>
          Shares read-only access to the request, status, and saved results.
          Other conversations, attachments and private context are excluded.
        </p>
      </details>
      <label>
        Access lifetime
        <select
          disabled={busy}
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
        >
          <option value="1">1 hour</option>
          <option value="8">8 hours</option>
          <option value="24">1 day</option>
          <option value="168">7 days</option>
        </select>
      </label>
      <div className="profile-action-row">
        <button
          className="button button--primary"
          type="submit"
          disabled={busy || !agentIds.length}
        >
          Approve access
        </button>
        <button
          className="button button--secondary"
          type="button"
          disabled={busy}
          onClick={() => void onDecide(false, [], [], "read-only", 1)}
        >
          Deny
        </button>
      </div>
    </form>
  );
}
