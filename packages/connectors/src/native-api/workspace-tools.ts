import type { BackendTool } from "@mivlet/protocol";

const paths = (maxItems: number) => ({ type: "array", maxItems, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } });

export const WORKSPACE_TOOLS: Record<string, BackendTool> = {
  "workspace-run": {
    name: "workspace-run", defaultMode: "full-access", defaultRisk: "critical",
    description: "Analyse selected file copies in WSL Ubuntu + Bubblewrap. Preserves originals; imports validated successful outputs. Inspect exit status.",
    parameters: JSON.stringify({ type: "object", properties: {
      command: { type: "string", minLength: 1, maxLength: 8192 },
      inputs: paths(32), outputs: paths(16),
      network: { type: "boolean", description: "Allow networking, including LAN." },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 300 },
    }, required: ["command", "inputs", "outputs", "network", "timeoutSeconds"], additionalProperties: false }),
  },
};
