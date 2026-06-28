import type { WorkflowDefinition } from "@fable/protocol";

export function starterWorkflows(now = new Date().toISOString()): WorkflowDefinition[] {
  return [
    {
      schemaVersion: 1,
      id: "starter-daily-brief",
      version: 1,
      name: "Daily brief",
      description: "Summarize the supplied workspace context. Add connector reads explicitly when connected.",
      steps: [{ kind: "prompt", id: "summarize", prompt: "Create a concise daily brief from the supplied context." }],
      notificationPrefs: {
        disableOs: false,
        enabledKinds: ["run-completed", "run-failed", "approval-needed"]
      },
      createdAt: now,
      updatedAt: now
    },
    {
      schemaVersion: 1,
      id: "starter-github-review",
      version: 1,
      name: "GitHub review",
      description: "Requires a connected GitHub account; reads only.",
      steps: [
        {
          kind: "connector-read",
          id: "read-github",
          connectorId: "github",
          capability: "github.repository.read",
          input: {},
          outputVar: "repository"
        },
        { kind: "agent", id: "review", prompt: "Summarize risks in the repository data.", requiresConnectors: ["github"], maxTurns: 4 }
      ],
      createdAt: now,
      updatedAt: now
    }
  ];
}
