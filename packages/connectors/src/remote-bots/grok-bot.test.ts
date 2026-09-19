import { describe, expect, it, vi } from "vitest";
import type { RemoteBotTransport } from "@mivlet/protocol";
import { GrokBotAdapter } from "./grok-bot";

const history = (botId = "bot-a", activity = "idle") => ({
  bot_id: botId,
  activity_state: activity,
  messages: [{ speaker: "bot", text: "Existing reply", timestamp_ms: null }],
  next_cursor: null,
  truncated: false,
  correlation: "not_claimed",
  completion_boundary: "activity_snapshot_not_task_completion",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const transport: RemoteBotTransport = {
    connect: vi.fn(async () => ({
      sessionId: "session-a",
      bots: [
        { id: "bot-a", name: "A" },
        { id: "bot-b", name: "B" },
      ],
    })),
    read: vi.fn(async () => history()),
    send: vi.fn(async () => ({
      bot_id: "bot-a",
      accepted: true,
      completion_boundary: "gateway_accepted_not_bot_reply",
    })),
    disconnect: vi.fn(async () => {}),
  };
  const adapter = new GrokBotAdapter(transport);
  await adapter.connect();
  adapter.select("bot-a");
  return { adapter, transport };
}

describe("Grok Bot remote-agent adapter", () => {
  it("sends once and treats acceptance as a receipt, not a reply", async () => {
    const { adapter, transport } = await fixture();
    expect(await adapter.send("Hello")).toContain("not a Bot reply");
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith(
      "session-a",
      "bot-a",
      "Hello",
      expect.any(String),
    );
    expect(transport.read).not.toHaveBeenCalled();
  });
  it.each([new Error("timeout"), new Error("disconnect")])(
    "never retries an uncertain send",
    async (failure) => {
      const { adapter, transport } = await fixture();
      vi.mocked(transport.send).mockRejectedValue(failure);
      expect(await adapter.send("Hello")).toContain("outcome unknown");
      expect(transport.send).toHaveBeenCalledTimes(1);
      await adapter.disconnect();
      await adapter.connect();
      adapter.select("bot-a");
      await adapter.read();
      expect(transport.send).toHaveBeenCalledTimes(1);
    },
  );
  it("treats malformed and wrong-target receipts as uncertain", async () => {
    const { adapter, transport } = await fixture();
    vi.mocked(transport.send).mockResolvedValue({
      accepted: true,
      bot_id: "bot-b",
    });
    expect(await adapter.send("Hello")).toContain("outcome unknown");
  });
  it("replaces snapshots without manufacturing duplicate poll replies or erasing repeated source entries", async () => {
    const { adapter, transport } = await fixture();
    const source = history();
    source.messages.push(source.messages[0]);
    vi.mocked(transport.read).mockResolvedValue(source);
    expect((await adapter.read())?.messages).toHaveLength(2);
    expect((await adapter.read())?.messages).toHaveLength(2);
    expect((await adapter.read())?.activity).toBe("idle");
  });
  it("discards late history after Bot selection changes", async () => {
    const { adapter, transport } = await fixture();
    const pending = deferred<unknown>();
    vi.mocked(transport.read).mockReturnValue(pending.promise);
    const read = adapter.read();
    adapter.select("bot-b");
    pending.resolve(history());
    expect(await read).toBeNull();
  });
  it("discards an older poll when a newer page was requested", async () => {
    const { adapter, transport } = await fixture();
    const pending = deferred<unknown>();
    vi.mocked(transport.read).mockReturnValueOnce(pending.promise);
    const first = adapter.read();
    await adapter.read("earlier-cursor");
    pending.resolve(history());
    expect(await first).toBeNull();
    expect(transport.read).toHaveBeenLastCalledWith(
      "session-a",
      "bot-a",
      "earlier-cursor",
    );
  });
  it("discards late sends on account/workspace disposal without calling remote cancellation", async () => {
    const { adapter, transport } = await fixture();
    const pending = deferred<unknown>();
    vi.mocked(transport.send).mockReturnValue(pending.promise);
    const send = adapter.send("Hello");
    await adapter.disconnect();
    pending.resolve({
      bot_id: "bot-a",
      accepted: true,
      completion_boundary: "gateway_accepted_not_bot_reply",
    });
    expect(await send).toBeNull();
    expect(transport.disconnect).toHaveBeenCalledWith("session-a");
    await expect(adapter.read()).rejects.toThrow("Connect and select");
  });
  it("closes a late connection after disposal", async () => {
    const { adapter, transport } = await fixture();
    const pending =
      deferred<Awaited<ReturnType<RemoteBotTransport["connect"]>>>();
    vi.mocked(transport.connect).mockReturnValue(pending.promise);
    const connect = adapter.connect();
    await Promise.resolve();
    await Promise.resolve();
    await adapter.disconnect();
    pending.resolve({ sessionId: "late", bots: [] });
    expect(await connect).toBeNull();
    expect(transport.disconnect).toHaveBeenCalledWith("late");
  });
  it("rejects unselected Bots, parallel sends and attachments disguised as input", async () => {
    const { adapter, transport } = await fixture();
    expect(() => adapter.select("foreign")).toThrow("Select a Bot");
    await expect(adapter.send("x".repeat(65537))).rejects.toThrow("64 KiB");
    const pending = deferred<unknown>();
    vi.mocked(transport.send).mockReturnValue(pending.promise);
    const send = adapter.send("once");
    await expect(adapter.send("twice")).rejects.toThrow("one send");
    expect(() => adapter.select("bot-b")).toThrow("send receipt");
    pending.resolve({});
    await send;
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it("rejects falsely correlated or wrong-Bot history", async () => {
    const { adapter, transport } = await fixture();
    vi.mocked(transport.read).mockResolvedValue(history("bot-b"));
    await expect(adapter.read()).rejects.toThrow("Unrecognized Bot history");
    vi.mocked(transport.read).mockResolvedValue({
      ...history(),
      correlation: "guaranteed",
    });
    await expect(adapter.read()).rejects.toThrow("Unrecognized Bot history");
  });
});
