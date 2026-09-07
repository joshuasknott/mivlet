import { describe, expect, it } from "vitest";
import { agentPresence } from "./agent-presence";
const idle: Parameters<typeof agentPresence>[0] = { running: false, status: "idle", lastError: null, activity: undefined, responseParts: [], transcript: "" };
describe("agent presence", () => {
  it("gives approval and failure priority over active work", () => {
    const active = { ...idle, running: true, activity: "Reading a file" };
    expect(agentPresence(active, true)).toBe("waiting");
    expect(agentPresence({ ...active, lastError: "Connection expired" })).toBe("blocked");
  });
  it("distinguishes starting, thinking, working, completion and rest", () => {
    expect(agentPresence(idle)).toBe("idle");
    expect(agentPresence(idle, false, true)).toBe("received");
    expect(agentPresence({ ...idle, running: true })).toBe("thinking");
    expect(agentPresence({ ...idle, running: true, transcript: "An answer" })).toBe("working");
    expect(agentPresence({ ...idle, status: "completed" })).toBe("done");
    expect(agentPresence({ ...idle, status: "cancelled" })).toBe("idle");
  });
});
