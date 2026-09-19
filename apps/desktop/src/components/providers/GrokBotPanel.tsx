import { useEffect, useRef, useState } from "react";
import type { RemoteBot, RemoteBotSnapshot } from "@mivlet/protocol";
import {
  GrokBotAdapter,
  grokBotConnection,
} from "@mivlet/connectors/remote-bots/grok-bot";
import {
  grokBotSetupScope,
  grokBotTransport,
} from "../../runtime/domains/grok-bot";
import "./grok-bot.css";

const activityCopy = {
  working: "Working remotely",
  awaiting_user: "Waiting for you",
  idle: "Idle — task completion is not verified",
  unknown: "Remote activity unknown",
};
const stoppedCopy =
  "Disconnected locally. The Bot may still be running in Grok Bot. Stop it there if needed. Any pending send may have arrived.";

export function GrokBotPanel({ onBack }: { onBack: () => void }) {
  const [adapter] = useState(() => new GrokBotAdapter(grokBotTransport));
  const epoch = useRef(0);
  const backRef = useRef<HTMLButtonElement>(null);
  const [scope, setScope] = useState("");
  const [bots, setBots] = useState<RemoteBot[]>([]);
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<RemoteBotSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState(
    "Connect your paired bridge to discover existing Bots.",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [watching, setWatching] = useState(false);
  const [older, setOlder] = useState(false);

  useEffect(() => {
    let active = true;
    backRef.current?.focus();
    void grokBotSetupScope()
      .then((value) => {
        if (active) setScope(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      epoch.current++;
      void adapter.disconnect().catch(() => {});
    };
  }, [adapter]);

  async function read(cursor?: string) {
    const generation = epoch.current;
    try {
      const page = await adapter.read(cursor);
      if (generation === epoch.current && page) setSnapshot(page);
    } catch (cause) {
      if (generation === epoch.current) {
        epoch.current++;
        setWatching(false);
        setSending(false);
        setStatus("Connection lost. The remote Bot may continue running.");
        setConnected(false);
        setSelected("");
        setBots([]);
        setSnapshot(null);
        setDraft("");
        void adapter.disconnect().catch(() => {});
        setError(
          typeof cause === "string"
            ? cause
            : cause instanceof Error
              ? cause.message
              : "History unavailable. Check the companion and reconnect.",
        );
      }
    }
  }

  useEffect(() => {
    if (!watching || !selected || sending || older) return;
    // Serial polling: no overlapping reads, no send retry and no inferred done.
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await read();
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [watching, selected, sending, older]);

  async function disconnect() {
    epoch.current++;
    setWatching(false);
    setConnected(false);
    setBusy(false);
    setSending(false);
    setBots([]);
    setSelected("");
    setSnapshot(null);
    setDraft("");
    setError("");
    setStatus(stoppedCopy);
    try {
      await adapter.disconnect();
    } catch {
      setError(
        "Local observation ended. Native disconnect could not be confirmed; close Mivlet and inspect Grok Bot.",
      );
    }
  }

  async function connect() {
    const generation = ++epoch.current;
    setBusy(true);
    setError("");
    setSnapshot(null);
    setSelected("");
    setBots([]);
    setConnected(false);
    setStatus("Checking bridge and companion…");
    try {
      const connection = await adapter.connect();
      if (generation !== epoch.current || !connection) return;
      setBots(connection.bots);
      setConnected(true);
      setStatus(
        connection.bots.length
          ? "Connected. Select a remote Bot."
          : "Connected. No non-group Bots found. Create one in Grok Bot, then reconnect.",
      );
    } catch (cause) {
      if (generation === epoch.current) {
        setStatus("Not connected");
        setError(
          typeof cause === "string"
            ? cause
            : cause instanceof Error
              ? cause.message
              : "Bridge unavailable. Follow the setup instructions and reconnect.",
        );
      }
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }

  return (
    <section
      className="grok-bot-panel"
      aria-label={grokBotConnection.label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void disconnect();
          onBack();
        }
      }}
    >
      <button
        ref={backRef}
        type="button"
        onClick={() => {
          void disconnect();
          onBack();
        }}
      >
        ← Grok connections
      </button>
      <h2>{grokBotConnection.label}</h2>
      <p>
        Use your connected Grok Bot account’s allowance. Promotional credit and
        its remaining balance have not been verified.
      </p>
      <p>
        Bots execute remotely under Grok Bot’s controls. Mivlet does not mediate
        their remote tool actions.
      </p>
      <details>
        <summary>Set up the bridge</summary>
        <ol>
          <li>
            Install WSL with Linux and Node 22, then install the pinned bridge{" "}
            {grokBotConnection.version}.
          </li>
          <li>
            Deploy your private relay. Pair from a WSL terminal using this
            account and workspace’s configuration directory:
          </li>
        </ol>
        <code>
          {scope
            ? `export XDG_CONFIG_HOME="$HOME/.config/mivlet-grok-bot/${scope}"`
            : "Open this in the signed-in Windows app to get your setup scope."}
        </code>
        <p>
          Start the same pinned companion in Grok Bot’s Computer terminal. Enter
          pairing secrets only in those terminals.
        </p>
        <a
          href="https://github.com/joshuasknott/mivlet/blob/feat/grok-bot-adapter/docs/development/grok-bot.md"
          target="_blank"
          rel="noreferrer"
        >
          Full setup instructions
        </a>
        <p>
          This is an unofficial paired bridge. There is no Mivlet OAuth login
          for Grok Bot.
        </p>
      </details>
      <div className="grok-bot-actions">
        <button
          type="button"
          disabled={busy || connected}
          onClick={() => void connect()}
        >
          {busy ? "Connecting…" : "Connect bridge"}
        </button>
        {(connected || busy) && (
          <button type="button" onClick={() => void disconnect()}>
            Disconnect
          </button>
        )}
      </div>
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
      {connected && bots.length > 0 && (
        <label>
          Remote Bot
          <select
            value={selected}
            disabled={sending}
            onChange={(event) => {
              const id = event.target.value;
              if (!id) return;
              epoch.current++;
              adapter.select(id);
              setSelected(id);
              setSnapshot(null);
              setDraft("");
              setError("");
              setOlder(false);
              setWatching(true);
              setStatus("Viewing the Bot’s existing remote conversation.");
            }}
          >
            <option value="" disabled>
              Select a Bot
            </option>
            {bots.map((bot) => (
              <option value={bot.id} key={bot.id}>
                {bot.name} · {bot.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <>
          <p>
            <strong>
              {snapshot
                ? activityCopy[snapshot.activity]
                : "Reading remote history…"}
            </strong>
          </p>
          <p className="grok-bot-note">
            {older ? "Earlier history page." : "Recent remote history."}{" "}
            Messages may come from other sessions. The bridge cannot link a
            reply to your send. Refreshes replace the page; identical source
            entries remain visible.
          </p>
          <div className="grok-bot-history" aria-label="Remote Bot history">
            {snapshot?.messages.map((message, index) => (
              <article key={index} data-speaker={message.speaker}>
                <small>
                  {message.speaker === "bot"
                    ? bots.find((bot) => bot.id === selected)?.name
                    : message.speaker === "peer"
                      ? "Another remote agent"
                      : "User in Grok Bot"}
                  {message.timestamp !== null
                    ? ` · ${new Date(message.timestamp).toLocaleString()}`
                    : " · time unavailable"}
                </small>
                <p>{message.text}</p>
              </article>
            ))}
            {snapshot?.messages.length === 0 && (
              <p>No text messages in this page.</p>
            )}
          </div>
          {snapshot?.truncated && (
            <p>Some history was truncated or omitted by the bridge.</p>
          )}
          <div className="grok-bot-actions">
            {snapshot?.nextCursor && (
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  setWatching(false);
                  setOlder(true);
                  void read(snapshot.nextCursor!);
                }}
              >
                Earlier history
              </button>
            )}
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                setOlder(false);
                setWatching(true);
                void read();
              }}
            >
              Latest history
            </button>
            <button type="button" onClick={() => void disconnect()}>
              Stop watching
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (sending || !draft.trim()) return;
              const message = draft;
              const generation = epoch.current;
              setDraft("");
              setSending(true);
              setError("");
              setStatus("Sending once…");
              void adapter
                .send(message)
                .then((receipt) => {
                  if (generation !== epoch.current || !receipt) return;
                  setStatus(receipt);
                  setOlder(false);
                  setWatching(true);
                })
                .catch((cause) => {
                  if (generation === epoch.current)
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Send unavailable.",
                    );
                })
                .finally(() => {
                  if (generation === epoch.current) setSending(false);
                });
            }}
          >
            <label>
              Message this Bot
              <textarea
                value={draft}
                maxLength={65536}
                disabled={sending}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
              />
            </label>
            <button type="submit" disabled={sending || !draft.trim()}>
              {sending ? "Sending…" : "Send to Bot"}
            </button>
          </form>
          <p className="grok-bot-note">
            Text only. Stop watching and Disconnect end local observation; they
            do not stop the remote Bot. Manage remote work in Grok Bot.
          </p>
        </>
      )}
    </section>
  );
}
