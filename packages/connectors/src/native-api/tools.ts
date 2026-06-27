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
  "search-notion": {
    name: "search-notion",
    description: "Search pages and databases explicitly shared with the connected Notion integration.",
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: JSON.stringify({ type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } }, required: ["query"] })
  },
  "search-slack": {
    name: "search-slack",
    description: "Search supported message data or list accessible channels in the connected Slack workspace.",
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: JSON.stringify({ type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } }, required: ["query"] })
  }
};

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
