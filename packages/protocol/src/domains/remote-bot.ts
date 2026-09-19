/** Remote agents have their own history and controls; they are not model IDs. */
export interface RemoteBot {
  id: string;
  name: string;
}

export interface RemoteBotSnapshot {
  botId: string;
  activity: "working" | "awaiting_user" | "idle" | "unknown";
  messages: {
    speaker: "user" | "bot" | "peer";
    text: string;
    timestamp: number | null;
  }[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface RemoteBotConnection {
  sessionId: string;
  bots: RemoteBot[];
}

/** No secrets, model selection, local tools, streaming, or cancellation promise. */
export interface RemoteBotTransport {
  connect(): Promise<RemoteBotConnection>;
  read(sessionId: string, botId: string, cursor?: string): Promise<unknown>;
  send(
    sessionId: string,
    botId: string,
    message: string,
    requestId: string,
  ): Promise<unknown>;
  disconnect(sessionId: string): Promise<void>;
}
