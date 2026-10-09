import type { BackendTool } from "@mivlet/protocol";

const paths = (maxItems: number) => ({ type: "array", maxItems, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } });
export const NATIVE_EXECUTION_POLICY = "Mivlet restricted Windows cmd; bundled Node/npm/Python/pip. Library setup. No host files/credentials/PATH/Git. Network off; network:true adds internetClient, no private-network/loopback exemptions. Python: python -m pip install --target .python-packages. Discard failure/Stop; import validated success. No command credentials. ";
export const PERSISTENT_EXECUTION_POLICY = "Start a native Windows job with bundled Node/npm/Python/pip. No host files/credentials/PATH, provider shell or stdin. Network off; true adds internetClient without private-network/loopback exemptions or host-browser access. Explicit 1–86400s lifetime; Stop/timeout ends descendants. Discard all writes, even success; never replay. Use command-jobs/command-output/command-stop. ";

export const WORKSPACE_TOOLS: Record<string, BackendTool> = {
  "workspace-start": {
    name: "workspace-start", defaultMode: "full-access", defaultRisk: "critical",
    description: PERSISTENT_EXECUTION_POLICY + "Use only explicitly selected input copies; import no outputs.",
    parameters: JSON.stringify({ type: "object", properties: {
      command: { type: "string", minLength: 1, maxLength: 8192 }, inputs: paths(32),
      network: { type: "boolean" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 },
    }, required: ["command", "inputs", "network", "timeoutSeconds"], additionalProperties: false }),
  },
  "workspace-run": {
    name: "workspace-run", defaultMode: "full-access", defaultRisk: "critical",
    description: NATIVE_EXECUTION_POLICY + "Analyse selected copies, preserve originals; import declared passive outputs. Real status, bounded output and receipt. Live logs: command-jobs/command-output.",
    parameters: JSON.stringify({ type: "object", properties: {
      command: { type: "string", minLength: 1, maxLength: 8192 },
      inputs: paths(32), outputs: paths(16),
      network: { type: "boolean" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 300 },
    }, required: ["command", "inputs", "outputs", "network", "timeoutSeconds"], additionalProperties: false }),
  },
};
