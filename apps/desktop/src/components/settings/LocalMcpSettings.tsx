import { useState } from "react";
import { McpClient } from "@fable/connectors";
import type { ApprovalRequest, ApprovalResolutionRequest } from "@fable/protocol";
import {
  commitRuntimeMcpServerConfiguration,
  listRuntimeMcpServerConfigurations,
  prepareRuntimeMcpServerConfiguration,
  resolveRuntimeApprovalRequest,
  type RuntimeMcpServerConfiguration,
  type RuntimeMcpServerSummary
} from "../../runtime";
import { createDesktopMcpTransport } from "../../lib/mcp-transport";

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
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [pending, setPending] = useState<PendingConfiguration | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);

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
        id: `local-${slug}-${Date.now().toString(36)}`,
        displayName: name,
        command,
        args: argsText.split(/\r?\n/).filter((line) => line.length > 0)
      };
      const prepared = await prepareRuntimeMcpServerConfiguration(configuration);
      if (!prepared) throw new Error("Local tool servers require the desktop app.");
      setPending({ configuration, approval: prepared.approval });
      setConfirmation("");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "That local tool server couldn’t be prepared.");
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
        onStatus("Local tool server saved. Check it before enabling any tools.");
      } else {
        onStatus("Local tool server wasn’t added.");
      }
      setPending(null);
      setConfirmation("");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "That local tool server couldn’t be saved.");
    } finally {
      setBusy(false);
    }
  };

  const check = async (server: RuntimeMcpServerSummary) => {
    setCheckingId(server.id);
    let client: McpClient | undefined;
    try {
      const transport = await createDesktopMcpTransport(workspaceId, server.id);
      if (!transport) throw new Error("Local tool servers require the desktop app.");
      client = new McpClient(transport, { authorizeToolCall: async () => false });
      const initialized = await client.initialize();
      const tools = initialized.capabilities.tools ? await client.listTools() : [];
      const resources = initialized.capabilities.resources ? await client.listResources() : [];
      onStatus(
        `${server.displayName} responded with ${tools.length} tool${tools.length === 1 ? "" : "s"} and ${resources.length} resource${resources.length === 1 ? "" : "s"}. Nothing was enabled.`
      );
    } catch (error) {
      onStatus(error instanceof Error ? error.message : `${server.displayName} couldn’t be checked.`);
    } finally {
      await client?.close().catch(() => undefined);
      setCheckingId(null);
    }
  };

  return (
    <article className="profile-clean-card settings-open-section mcp-settings">
      <div className="profile-clean-card__content">
        <section className="profile-section" aria-labelledby="local-tool-servers-title">
          <div className="profile-section__heading">
            <span>
              <strong id="local-tool-servers-title">Local tool servers</strong>
              <small>Advanced. Connect a program already installed on this computer.</small>
            </span>
          </div>

          <details
            className="mcp-settings__advanced"
            onToggle={(event) => {
              if (event.currentTarget.open && !loaded) {
                void refresh().catch(() => onStatus("Local tool servers couldn’t be loaded."));
              }
            }}
          >
            <summary>Manage local tool servers</summary>
            {!loaded ? <p>Reading saved local servers…</p> : !desktopAvailable ? (
              <p>Local tool servers are available only in the desktop app.</p>
            ) : (
              <>
              {servers.length > 0 ? (
                <div className="provider-access-list">
                  {servers.map((server) => (
                    <div className="provider-access-row" key={server.id}>
                      <span>
                        <strong>{server.displayName}</strong>
                        <small>{server.disabled ? "Off" : "Saved locally · No tools enabled"}</small>
                      </span>
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={checkingId === server.id || server.disabled}
                        onClick={() => void check(server)}
                      >
                        {checkingId === server.id ? "Checking…" : "Check server"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : <p>No local tool servers saved.</p>}

              <details>
                <summary>Add a server</summary>
                <p>Only add software you trust. Credentials in commands or arguments are blocked.</p>
                <div className="mcp-settings__form">
                  <label className="settings-field">
                    <span>Name</span>
                    <input value={name} onChange={(event) => setName(event.target.value)} placeholder="My local tools" />
                  </label>
                  <label className="settings-field">
                    <span>Program path</span>
                    <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="C:\\path\\to\\server.exe" />
                  </label>
                  <label className="settings-field">
                    <span>Arguments <small>(one per line)</small></span>
                    <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={3} />
                  </label>
                  <button type="button" className="button button--secondary" disabled={busy || !name.trim() || !command.trim()} onClick={() => void prepare()}>
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
          <strong id="mcp-confirm-title">Allow {pending.configuration.displayName} to run?</strong>
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
