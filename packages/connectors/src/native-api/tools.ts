/**
 * Fable-owned tool registry. Model tool calls don't auto-execute — each is
 * matched against this registry, routed through an ApprovalRequest, and executed
 * by an Fable runtime function only after the user grants. Tools the model
 * invents that aren't registered here fail closed (critical risk, never run).
 *
 * The `defaultMode`/`defaultRisk` are the *defaults* surfaced to the user; the
 * existing approval UI lets them modify before granting.
 */

import type { BackendTool, NativeToolSpec } from "@fable/protocol";

const TOOLS: Record<string, BackendTool> = {
  "read-file": {
    name: "read-file",
    description: "Read a text file from the workspace.",
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: JSON.stringify({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    })
  },
  "write-file": {
    name: "write-file",
    description: "Write or overwrite a workspace file.",
    defaultMode: "full-access",
    defaultRisk: "high",
    parameters: JSON.stringify({
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    })
  },
  "run-shell": {
    name: "run-shell",
    description: "Run a shell command in the workspace.",
    defaultMode: "full-access",
    defaultRisk: "critical",
    parameters: JSON.stringify({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    })
  },
  "web-fetch": {
    name: "web-fetch",
    description: "Fetch a URL and return its text.",
    defaultMode: "read-only",
    defaultRisk: "medium",
    parameters: JSON.stringify({
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"]
    })
  },
  "github-read": connectorReadTool("github"),
  "vercel-read": connectorReadTool("vercel"),
  "linear-read": connectorReadTool("linear"),
  "google-drive-read": {
    name: "google-drive-read",
    description: "Search Google Drive or read file metadata using the connected account and granted scopes.",
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        operation: { type: "string", enum: ["search", "metadata"] },
        query: { type: "string" },
        fileId: { type: "string" },
        cursor: { type: "string" }
      },
      required: ["operation"]
    })
  },
  "gmail-read": {
    name: "gmail-read",
    description: "Search or read selected Gmail messages and threads using the connected account.",
    defaultMode: "read-only",
    defaultRisk: "medium",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        operation: { type: "string", enum: ["search", "message", "thread"] },
        query: { type: "string" },
        messageId: { type: "string" },
        threadId: { type: "string" },
        cursor: { type: "string" }
      },
      required: ["operation"]
    })
  },
  "google-calendar-read": {
    name: "google-calendar-read",
    description: "List calendars, read events, or check free/busy conflicts using the connected account.",
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        operation: { type: "string", enum: ["calendars", "events", "event", "freebusy"] },
        calendarId: { type: "string" },
        calendarIds: { type: "array", items: { type: "string" } },
        eventId: { type: "string" },
        q: { type: "string" },
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        pageToken: { type: "string" }
      },
      required: ["operation"]
    })
  }
};

function connectorReadTool(connector: "github" | "vercel" | "linear"): BackendTool {
  return {
    name: `${connector}-read`,
    description: `Read authenticated ${connector} data through a declared connector capability.`,
    defaultMode: "read-only",
    defaultRisk: "medium",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        capability: { type: "string" },
        input: { type: "object", additionalProperties: true },
        cursor: { type: "string" }
      },
      required: ["capability", "input"]
    })
  };
}

/** All registered tools, as specs advertised to the model. */
export function registeredToolSpecs(): NativeToolSpec[] {
  return Object.values(TOOLS).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

/** Look up a registered tool by name (undefined if not registered). */
export function lookupTool(name: string): BackendTool | undefined {
  return TOOLS[name];
}
