import { describe, expect, it } from "vitest";
import { agentPresence, isPresenceScopeCurrent, presenceLabel } from "./agent-presence";
const idle: Parameters<typeof agentPresence>[0] = { running: false, status: "idle", lastError: null, activity: undefined, responseParts: [], transcript: "" };
describe("agent presence", () => {
  it("does not animate stale tools after a stop, interruption or failure", () => {
    const stale = { ...idle, activity: "Writing a file", transcript: "Old answer" };
    expect(agentPresence({ ...stale, status: "cancelled" })).toBe("paused");
    expect(agentPresence({ ...stale, status: "interrupted" })).toBe("paused");
    expect(agentPresence({ ...stale, status: "failed" })).toBe("blocked");
    expect(agentPresence({ ...stale, status: "failed" }, false, true)).toBe("blocked");
  });
  it("separates provider waiting from human attention and respects control ownership", () => {
    const retrying = { ...idle, running: true, status: "retrying" as const };
    expect(agentPresence(retrying)).toBe("service");
    expect(agentPresence(retrying, true)).toBe("waiting");
    expect(agentPresence(retrying, false, false, { computerController: "human" })).toBe("human");
    expect(agentPresence(retrying, false, false, { computerController: "paused" })).toBe("paused");
    expect(agentPresence(retrying, true, false, { computerController: "human" })).toBe("waiting");
    expect(agentPresence(idle, false, false, { awaitingInput: true })).toBe("input");
    expect(agentPresence({ ...idle, status: "failed", lastError: "Provider stopped" }, false, false, { providerUnavailable: true })).toBe("blocked");
    expect(agentPresence({ ...idle, status: "cancelled", lastError: "Late provider error" }, false, false, { awaitingInput: true, listening: true, speaking: true })).toBe("paused");
    expect(agentPresence({ ...idle, stopRequested: true }, false, false, { awaitingInput: true, listening: true, speaking: true })).toBe("paused");
    expect(agentPresence({ ...idle, running: true, status: "awaiting-approval", stopRequested: true }, false, false, { listening: true })).toBe("paused");
    expect(agentPresence({ ...idle, running: true, status: "awaiting-approval", stopRequested: true }, true)).toBe("waiting");
    expect(agentPresence({ ...idle, status: "failed", lastError: "Failed" }, false, false, { awaitingInput: true, listening: true, speaking: true })).toBe("blocked");
    expect(agentPresence(idle, false, false, { computerController: "human", awaitingInput: true, listening: true, speaking: true })).toBe("human");
    expect(agentPresence(idle, true, true, { computerController: "human", awaitingInput: true, listening: true, speaking: true })).toBe("waiting");
  });
  it("uses confirmed availability and voice facts, never transcript content", () => {
    expect(agentPresence(idle, false, false, { providerUnavailable: true })).toBe("unavailable");
    expect(agentPresence(idle, false, false, { listening: true })).toBe("listening");
    expect(agentPresence(idle, false, false, { speaking: true })).toBe("speaking");
    expect(agentPresence({ ...idle, running: true, transcript: "Do you want me to continue?" })).toBe("working");
    expect(presenceLabel("working", "Reading Google Drive")).toBe("Reading Google Drive");
    expect(presenceLabel("paused", "Reading Google Drive")).toBe("Paused");
  });
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
    expect(agentPresence({ ...idle, status: "cancelled" })).toBe("paused");
  });
  it("requires progress to belong to the selected agent and conversation", () => {
    const scoped = { progressAgentId: "agent-a", progressThreadId: "thread-a" };
    expect(isPresenceScopeCurrent(scoped, { agentId: "agent-a", threadId: "thread-a" })).toBe(true);
    expect(isPresenceScopeCurrent(scoped, { agentId: "agent-b", threadId: "thread-a" })).toBe(false);
    expect(isPresenceScopeCurrent(scoped, { agentId: "agent-a", threadId: "thread-b" })).toBe(false);
    expect(isPresenceScopeCurrent({}, { agentId: "agent-a", threadId: "thread-a" })).toBe(true);
  });
});
