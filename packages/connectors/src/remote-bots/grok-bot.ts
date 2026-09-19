import type {
  RemoteBotConnection,
  RemoteBotSnapshot,
  RemoteBotTransport,
} from "@mivlet/protocol";

export const grokBotConnection = {
  id: "grok-bot",
  familyId: "xai",
  label: "Grok Bot (Experimental)",
  kind: "remote-agent",
  version: "0.2.0-beta.8",
} as const;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid bridge response. Reconnect the bridge.");
  return value as Record<string, unknown>;
};

function snapshot(value: unknown, botId: string): RemoteBotSnapshot {
  const data = record(value);
  if (
    data.bot_id !== botId ||
    data.correlation !== "not_claimed" ||
    data.completion_boundary !== "activity_snapshot_not_task_completion" ||
    !["working", "awaiting_user", "idle", "unknown"].includes(
      String(data.activity_state),
    ) ||
    !Array.isArray(data.messages) ||
    data.messages.length > 50 ||
    !(data.next_cursor === null || typeof data.next_cursor === "string") ||
    typeof data.truncated !== "boolean"
  ) {
    throw new Error(
      "Unrecognized Bot history. Reconnect with the supported bridge version.",
    );
  }
  const messages = data.messages.map((item) => {
    const entry = record(item);
    if (
      !["user", "bot", "peer"].includes(String(entry.speaker)) ||
      typeof entry.text !== "string" ||
      entry.text.length > 16384 ||
      !(
        entry.timestamp_ms === null ||
        (typeof entry.timestamp_ms === "number" &&
          Number.isSafeInteger(entry.timestamp_ms) &&
          entry.timestamp_ms >= 0)
      )
    ) {
      throw new Error("Invalid Bot message. Refresh the history.");
    }
    return {
      speaker: entry.speaker as "user" | "bot" | "peer",
      text: entry.text,
      timestamp: entry.timestamp_ms as number | null,
    };
  });
  return {
    botId,
    activity: data.activity_state as RemoteBotSnapshot["activity"],
    messages,
    nextCursor: data.next_cursor as string | null,
    truncated: data.truncated,
  };
}

/** Generation fences cover reconnect, selection changes, Stop, and disposal. */
export class GrokBotAdapter {
  private generation = 0;
  private connection: RemoteBotConnection | null = null;
  private selected: string | null = null;
  private sending = false;
  private readSequence = 0;
  constructor(private transport: RemoteBotTransport) {}

  async connect(): Promise<RemoteBotConnection | null> {
    const generation = ++this.generation;
    const previous = this.connection;
    this.connection = null;
    this.selected = null;
    this.sending = false;
    if (previous) await this.transport.disconnect(previous.sessionId);
    if (generation !== this.generation) return null;
    const connection = await this.transport.connect();
    if (generation !== this.generation) {
      await this.transport.disconnect(connection.sessionId);
      return null;
    }
    this.connection = connection;
    return connection;
  }

  select(botId: string) {
    if (this.sending)
      throw new Error(
        "Wait for the send receipt or stop watching before changing Bots.",
      );
    if (!this.connection?.bots.some((bot) => bot.id === botId))
      throw new Error("Select a Bot from this connection.");
    this.generation++;
    this.selected = botId;
  }

  async read(cursor?: string): Promise<RemoteBotSnapshot | null> {
    const connection = this.connection;
    const botId = this.selected;
    const generation = this.generation;
    const sequence = ++this.readSequence;
    if (!connection || !botId)
      throw new Error("Connect and select a Bot first.");
    const value = await this.transport.read(
      connection.sessionId,
      botId,
      cursor,
    );
    if (generation !== this.generation || sequence !== this.readSequence)
      return null;
    // Replace a bounded page, never append a poll. There are no stable message IDs;
    // deduping by text would also erase legitimate repeated messages.
    return snapshot(value, botId);
  }

  async send(message: string): Promise<string | null> {
    const connection = this.connection;
    const botId = this.selected;
    const generation = this.generation;
    if (!connection || !botId || this.sending)
      throw new Error(
        "Connect and select a Bot; only one send can be pending.",
      );
    if (
      !message.trim() ||
      message.includes("\0") ||
      new TextEncoder().encode(message).length > 65536
    )
      throw new Error("Enter a message of at most 64 KiB.");
    this.sending = true;
    try {
      // Exactly one attempt. Transport rejection and malformed receipts are uncertain.
      const value = record(
        await this.transport.send(
          connection.sessionId,
          botId,
          message,
          crypto.randomUUID(),
        ),
      );
      if (generation !== this.generation) return null;
      if (
        value.bot_id !== botId ||
        value.accepted !== true ||
        value.completion_boundary !== "gateway_accepted_not_bot_reply"
      )
        throw new Error("Uncertain receipt");
      return "Accepted by the gateway. Waiting for remote activity; this is not a Bot reply.";
    } catch {
      if (generation !== this.generation) return null;
      return "Send outcome unknown. It may have arrived. Inspect the Bot in Grok Bot before sending again; Mivlet will not resend it.";
    } finally {
      if (generation === this.generation) this.sending = false;
    }
  }

  async disconnect() {
    this.generation++;
    const connection = this.connection;
    this.connection = null;
    this.selected = null;
    this.sending = false;
    if (connection) await this.transport.disconnect(connection.sessionId);
    // Disconnect only ends observation. The remote agent may continue executing.
  }
}
