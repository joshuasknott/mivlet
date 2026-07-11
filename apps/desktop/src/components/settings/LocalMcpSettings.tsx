import { useState } from "react";
import { McpClient } from "@fable/connectors";
import type { ApprovalRequest, ApprovalResolutionRequest } from "@fable/protocol";
import {
  beginRuntimeRemoteMcpAuthorization,
  commitRuntimeMcpServerConfiguration,
  disconnectRuntimeRemoteMcpAuthorization,
  inspectRuntimeRemoteMcpAuthorization,
  listRuntimeMcpServerConfigurations,
  prepareRuntimeMcpServerConfiguration,
  resolveRuntimeApprovalRequest,
  setRuntimeMcpEnablement,
  type RuntimeMcpConnectionDetails,
  type RuntimeMcpServerConfiguration,
  type RuntimeMcpServerSummary
} from "../../runtime";
import {
  createDesktopMcpTransport,
  createDesktopRemoteMcpTransport
} from "../../lib/mcp-transport";

interface PendingConfiguration {
  configuration: RuntimeMcpServerConfiguration;
  approval: ApprovalRequest;
}

export function LocalMcpSettings({
  workspaceId,
  onStatus
}: {
  workspaceId: string;
  onStatus: (message: string) => void;
}) {
  const [servers, setServers] = useState<RuntimeMcpServerSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [desktopAvailable, setDesktopAvailable] = useState(true);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "streamable-http">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [pending, setPending] = useState<PendingConfiguration | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [authorizingId, setAuthorizingId] = useState<string | null>(null);
  const [discoveries, setDiscoveries] = useState<Record<string, RuntimeMcpConnectionDetails>>({});
  const [enablementDrafts, setEnablementDrafts] = useState<Record<string, {
    tools: string[];
    resources: string[];
    knowledgeSearchTool: string;
  }>>({});

  const refresh = async () => {
    const loaded = await listRuntimeMcpServerConfigurations(workspaceId);
    if (loaded === null) {
      setDesktopAvailable(false);
      setLoaded(true);
      return;
    }
    setDesktopAvailable(true);
    setServers(loaded);
    setLoaded(true);
  };

  const prepare = async () => {
    setBusy(true);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
      const configuration: RuntimeMcpServerConfiguration = {
        workspaceId,
        id: `${transport === "stdio" ? "local" : "remote"}-${slug}-${Date.now().toString(36)}`,
        displayName: name,
        transport,
        ...(transport === "stdio"
          ? { command, args: argsText.split(/\r?\n/).filter((line) => line.length > 0) }
          : { endpoint })
      };
      const prepared = await prepareRuntimeMcpServerConfiguration(configuration);
      if (!prepared) throw new Error("Tool servers require the desktop app.");
      setPending({ configuration, approval: prepared.approval });
      setConfirmation("");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "That tool server couldn’t be prepared.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "once" | "deny") => {
    if (!pending) return;
    setBusy(true);
    const resolution: ApprovalResolutionRequest = {
      request: pending.approval,
      decision,
      decidedAt: new Date().toISOString(),
      ...(decision === "once" ? { confirmationText: confirmation } : {})
    };
    try {
      await resolveRuntimeApprovalRequest(resolution);
      if (decision === "once") {
        await commitRuntimeMcpServerConfiguration(pending.configuration, resolution);
        await refresh();
        setName("");
        setCommand("");
        setArgsText("");
        setEndpoint("");
        onStatus(`${pending.configuration.transport === "stdio" ? "Local" : "Remote"} tool server saved. Check it before enabling any tools.`);
      } else {
        onStatus("Tool server wasn’t added.");
      }
      setPending(null);
      setConfirmation("");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "That tool server couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  };

  const check = async (server: RuntimeMcpServerSummary) => {
    setCheckingId(server.id);
    let client: McpClient | undefined;
    try {
      const mcpTransport = server.transport === "streamable-http"
        ? await createDesktopRemoteMcpTransport(workspaceId, server.id)
        : await createDesktopMcpTransport(workspaceId, server.id);
      if (!mcpTransport) throw new Error("Tool servers require the desktop app.");
      client = new McpClient(mcpTransport, { authorizeToolCall: async () => false });
      const initialized = await client.initialize();
      const tools = initialized.capabilities.tools ? await client.listTools() : [];
      const resources = initialized.capabilities.resources ? await client.listResources() : [];
      const discovery = await mcpTransport.recordDiscovery(
        tools.map((tool) => tool.name),
        resources.map((resource) => resource.uri)
      );
      setDiscoveries((current) => ({ ...current, [server.id]: discovery }));
      setEnablementDrafts((current) => ({
        ...current,
        [server.id]: {
          tools: discovery.enabledTools,
          resources: discovery.enabledResources,
          knowledgeSearchTool: (discovery.capabilityBindings ?? []).find(
            (binding) => binding.capabilityId === "knowledge.content.search"
          )?.toolName ?? ""
        }
      }));
      onStatus(
        `${server.displayName} responded with ${tools.length} tool${tools.length === 1 ? "" : "s"} and ${resources.length} resource${resources.length === 1 ? "" : "s"}. Nothing was enabled.`
      );
    } catch (error) {
      if (
        server.transport === "streamable-http" &&
        error instanceof Error &&
        error.message.includes("HTTP 401")
      ) {
        try {
          const authorization = await inspectRuntimeRemoteMcpAuthorization(workspaceId, server.id);
          if (authorization) {
            onStatus(
              `${server.displayName} requires sign-in and advertises secure S256 authorization. Connecting an account is ready through Connect account.`
            );
          } else {
            onStatus("Remote tool-server sign-in requires the desktop app.");
          }
        } catch (authorizationError) {
          onStatus(
            authorizationError instanceof Error
              ? authorizationError.message
              : `${server.displayName} sign-in setup couldn’t be verified.`
          );
        }
      } else {
        onStatus(error instanceof Error ? error.message : `${server.displayName} couldn’t be checked.`);
      }
    } finally {
      await client?.close().catch(() => undefined);
      setCheckingId(null);
    }
  };

  const toggleDraft = (serverId: string, kind: "tools" | "resources", value: string) => {
    setEnablementDrafts((current) => {
      const draft = current[serverId] ?? { tools: [], resources: [], knowledgeSearchTool: "" };
      const values = draft[kind];
      return {
        ...current,
        [serverId]: {
          ...draft,
          [kind]: values.includes(value)
            ? values.filter((candidate) => candidate !== value)
            : [...values, value],
          ...(kind === "tools" && draft.knowledgeSearchTool === value
            ? { knowledgeSearchTool: "" }
            : {})
        }
      };
    });
  };

  const authorize = async (server: RuntimeMcpServerSummary) => {
    setAuthorizingId(server.id);
    try {
      const result = await beginRuntimeRemoteMcpAuthorization(workspaceId, server.id);
      if (!result) throw new Error("Remote tool-server sign-in requires the desktop app.");
      onStatus(`${server.displayName} account connected. Check the server before enabling any access.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : `${server.displayName} sign-in didnâ€™t finish.`);
    } finally {
      setAuthorizingId(null);
    }
  };

  const disconnectAccount = async (server: RuntimeMcpServerSummary) => {
    setAuthorizingId(server.id);
    try {
      const result = await disconnectRuntimeRemoteMcpAuthorization(workspaceId, server.id);
      if (!result) throw new Error("Remote tool-server sign-out requires the desktop app.");
      setDiscoveries((current) => {
        const next = { ...current };
        delete next[server.id];
        return next;
      });
      onStatus(`${server.displayName} account disconnected. Its saved tool access cannot run until you reconnect and check it again.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : `${server.displayName} couldn’t be disconnected.`);
    } finally {
      setAuthorizingId(null);
    }
  };

  const saveEnablement = async (server: RuntimeMcpServerSummary) => {
    const discovery = discoveries[server.id];
    const draft = enablementDrafts[server.id];
    if (!discovery || !draft) return;
    setBusy(true);
    try {
      const saved = await setRuntimeMcpEnablement(
        workspaceId,
        discovery.connectionId,
        discovery.connectionRevision,
        draft.tools,
        draft.resources,
        draft.knowledgeSearchTool
          ? [{ capabilityId: "knowledge.content.search", toolName: draft.knowledgeSearchTool }]
          : []
      );
      if (!saved) throw new Error("Local tool access requires the desktop app.");
      setDiscoveries((current) => ({ ...current, [server.id]: saved }));
      onStatus(`Access saved for ${server.displayName}. Tool calls still require Fable permission.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Local tool access couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="profile-clean-card settings-open-section mcp-settings">
      <div className="profile-clean-card__content">
        <section className="profile-section" aria-labelledby="local-tool-servers-title">
          <div className="profile-section__heading">
            <span>
              <strong id="local-tool-servers-title">Tool servers</strong>
              <small>Advanced. Connect trusted tools on this computer or over HTTPS.</small>
            </span>
          </div>

          <details
            className="mcp-settings__advanced"
            onToggle={(event) => {
              if (event.currentTarget.open && !loaded) {
                void refresh().catch(() => onStatus("Tool servers couldn’t be loaded."));
              }
            }}
          >
            <summary>Manage tool servers</summary>
            {!loaded ? <p>Reading saved local servers…</p> : !desktopAvailable ? (
              <p>Tool servers are available only in the desktop app.</p>
            ) : (
              <>
              {servers.length > 0 ? (
                <div className="provider-access-list">
                  {servers.map((server) => {
                    const discovery = discoveries[server.id];
                    const draft = enablementDrafts[server.id];
                    return <div className="mcp-settings__server" key={server.id}>
                      <div className="provider-access-row">
                        <span>
                          <strong>{server.displayName}</strong>
                          <small>{server.disabled ? "Off" : `${server.transport === "stdio" ? "Saved locally" : "Remote HTTPS"} · No tools enabled by default`}</small>
                        </span>
                        <button
                          type="button"
                          className="button button--secondary"
                          disabled={checkingId === server.id || server.disabled}
                          onClick={() => void check(server)}
                        >
                          {checkingId === server.id ? "Checking…" : "Check server"}
                        </button>
                        {server.transport === "streamable-http" ? (
                          <span className="profile-action-row">
                            <button
                              type="button"
                              className="button button--secondary"
                              disabled={authorizingId === server.id || server.disabled}
                              onClick={() => void authorize(server)}
                            >
                              {authorizingId === server.id ? "Workingâ€¦" : "Connect account"}
                            </button>
                            <button
                              type="button"
                              className="button button--secondary"
                              disabled={authorizingId === server.id || server.disabled}
                              onClick={() => void disconnectAccount(server)}
                            >
                              Disconnect account
                            </button>
                          </span>
                        ) : null}
                      </div>
                      {discovery && draft ? (
                        <div className="mcp-settings__access" aria-label={`${server.displayName} access`}>
                          <strong>Available access</strong>
                          <small>Select only what Fable may consider using. Every tool call still passes Fable permissions and approval.</small>
                          {[...discovery.discoveredTools.map((value) => ({ kind: "tools" as const, value })), ...discovery.discoveredResources.map((value) => ({ kind: "resources" as const, value }))].map((item) => (
                            <label key={`${item.kind}:${item.value}`}>
                              <input
                                type="checkbox"
                                checked={draft[item.kind].includes(item.value)}
                                onChange={() => toggleDraft(server.id, item.kind, item.value)}
                              />
                              <span>{item.value}</span>
                            </label>
                          ))}
                          <label className="settings-field">
                            <span>Connected-source search tool</span>
                            <select
                              value={draft.knowledgeSearchTool}
                              onChange={(event) => {
                                const toolName = event.target.value;
                                setEnablementDrafts((current) => ({
                                  ...current,
                                  [server.id]: {
                                    ...draft,
                                    knowledgeSearchTool: toolName,
                                    tools: toolName && !draft.tools.includes(toolName)
                                      ? [...draft.tools, toolName]
                                      : draft.tools
                                  }
                                }));
                              }}
                            >
                              <option value="">Not used for connected-source search</option>
                              {discovery.discoveredTools.map((toolName) => (
                                <option key={toolName} value={toolName}>{toolName}</option>
                              ))}
                            </select>
                            <small>The tool must return Fable's cited-search contract. Results stay untrusted.</small>
                          </label>
                          <button type="button" className="button button--secondary" disabled={busy} onClick={() => void saveEnablement(server)}>Save access</button>
                        </div>
                      ) : null}
                    </div>
                  })}
                </div>
              ) : <p>No tool servers saved.</p>}

              <details>
                <summary>Add a server</summary>
                <p>Only add software you trust. Credentials in commands, arguments, or web addresses are blocked.</p>
                <div className="mcp-settings__form">
                  <label className="settings-field">
                    <span>Location</span>
                    <select value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "streamable-http")}>
                      <option value="stdio">This computer</option>
                      <option value="streamable-http">Remote HTTPS server</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Name</span>
                    <input value={name} onChange={(event) => setName(event.target.value)} placeholder="My tools" />
                  </label>
                  {transport === "stdio" ? <>
                    <label className="settings-field">
                      <span>Program path</span>
                      <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="C:\\path\\to\\server.exe" />
                    </label>
                    <label className="settings-field">
                      <span>Arguments <small>(one per line)</small></span>
                      <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={3} />
                    </label>
                  </> : <label className="settings-field">
                    <span>HTTPS address</span>
                    <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://example.com/mcp" />
                  </label>}
                  <button type="button" className="button button--secondary" disabled={busy || !name.trim() || !(transport === "stdio" ? command.trim() : endpoint.trim())} onClick={() => void prepare()}>
                    Review and save
                  </button>
                </div>
              </details>
              </>
            )}
          </details>
        </section>
      </div>

      {pending ? (
        <section className="settings-confirmation" role="dialog" aria-modal="true" aria-labelledby="mcp-confirm-title">
          <strong id="mcp-confirm-title">
            {pending.configuration.transport === "stdio"
              ? `Allow ${pending.configuration.displayName} to run?`
              : `Connect to ${pending.configuration.displayName}?`}
          </strong>
          <p>{pending.approval.consequence}</p>
          <p>No tools or resources will be enabled by saving it.</p>
          <label className="settings-field">
            <span>Type “{pending.approval.confirmationPhrase}” to continue</span>
            <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
          <div className="profile-action-row">
            <button type="button" className="button button--secondary" disabled={busy} onClick={() => void decide("deny")}>Cancel</button>
            <button type="button" className="button" disabled={busy || confirmation !== pending.approval.confirmationPhrase} onClick={() => void decide("once")}>Save server</button>
          </div>
        </section>
      ) : null}
    </article>
  );
}
