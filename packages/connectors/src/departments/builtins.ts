import type {
  ApprovalRequirement,
  ConnectorNeed,
  Department,
  DepartmentId,
  Pipeline,
  RuntimeRoute,
  WorkflowDefinition
} from "@fable/protocol";
import { requiredConnectors, validateWorkflowDefinition } from "../workflows";

export interface DepartmentPlan {
  departmentId: DepartmentId;
  pipelineId: string;
  workflowDefinitionId: string;
  runnable: boolean;
  missingConnectors: ConnectorNeed[];
  approvalRequirement: ApprovalRequirement;
  runtimeRoute: RuntimeRoute;
  stepOrder: string[];
  errors: string[];
}

const route = (permissionMode: RuntimeRoute["permissionMode"]): RuntimeRoute => ({
  kind: "agent-backend",
  policy: "current-default",
  permissionMode
});

export function builtInDepartments(now = new Date().toISOString()): Department[] {
  return [
    researchDepartment(now),
    shipDepartment(now)
  ];
}

export function departmentPipelines(now = new Date().toISOString()): Pipeline[] {
  return builtInDepartments(now).flatMap((department) => department.pipelines);
}

export function planDepartmentPipeline(
  pipeline: Pipeline,
  connectedConnectorIds: readonly string[] = []
): DepartmentPlan {
  const connected = new Set(connectedConnectorIds);
  const workflowErrors = validateWorkflowDefinition(pipeline.workflow);
  const workflowNeeds = new Set(pipeline.workflow.steps.flatMap(requiredConnectors));
  const declaredNeedIds = new Set(pipeline.connectorNeeds.map((need) => need.connectorId));
  const declarationErrors = [...workflowNeeds]
    .filter((connectorId) => !declaredNeedIds.has(connectorId))
    .map((connectorId) => `${connectorId} is required by workflow steps but not declared as a connector need.`);
  const missingConnectors = pipeline.connectorNeeds.filter(
    (need) => !need.optional && !connected.has(need.connectorId)
  );

  return {
    departmentId: pipeline.departmentId,
    pipelineId: pipeline.id,
    workflowDefinitionId: pipeline.workflow.id,
    runnable: workflowErrors.length === 0 && declarationErrors.length === 0 && missingConnectors.length === 0,
    missingConnectors,
    approvalRequirement: pipeline.approvalRequirement,
    runtimeRoute: pipeline.runtimeRoute,
    stepOrder: pipeline.workflow.steps.map((step) => step.id),
    errors: [...workflowErrors, ...declarationErrors]
  };
}

function researchDepartment(now: string): Department {
  const workflow: WorkflowDefinition = {
    schemaVersion: 1,
    id: "department-research-context-brief",
    version: 1,
    name: "Research context brief",
    description: "Gather workspace context and connected read-only sources into a cited brief.",
    steps: [
      {
        kind: "prompt",
        id: "gather-knowledge",
        prompt: "Search the local knowledge context for the user's topic and identify the most relevant cited sources."
      },
      {
        kind: "connector-read",
        id: "read-github",
        connectorId: "github",
        capability: "github.repository.read",
        input: { query: "{{topic}}" },
        outputVar: "githubContext"
      },
      {
        kind: "agent",
        id: "synthesize-brief",
        prompt: "Produce a concise research brief with citations, open questions, and next useful connector reads.",
        maxTurns: 3,
        requiresConnectors: ["github"]
      }
    ],
    notificationPrefs: {
      disableOs: false,
      enabledKinds: ["run-completed", "run-failed", "approval-needed"]
    },
    createdAt: now,
    updatedAt: now
  };
  return {
    id: "research",
    name: "Research",
    summary: "Turn local knowledge and read-only connector context into a grounded brief.",
    pipelines: [
      {
        id: "research-context-brief",
        departmentId: "research",
        name: "Context brief",
        description: "A manual lane for gathering and summarizing the evidence already available to Fable.",
        steps: [
          {
            id: "research-step-knowledge",
            title: "Search Knowledge",
            description: "Use local sources and cited retrieval first.",
            workflowStepId: "gather-knowledge"
          },
          {
            id: "research-step-connectors",
            title: "Read connected sources",
            description: "Optionally read GitHub metadata when the connector is connected.",
            workflowStepId: "read-github"
          },
          {
            id: "research-step-brief",
            title: "Write brief",
            description: "Run through the selected AgentBackend with read-only permissions.",
            workflowStepId: "synthesize-brief"
          }
        ],
        connectorNeeds: [
          {
            connectorId: "github",
            access: "read",
            reason: "Repository metadata and code context enrich the research brief."
          }
        ],
        scheduleTrigger: {
          kind: "manual",
          description: "Run when the user asks for a brief."
        },
        approvalRequirement: {
          kind: "none",
          reason: "The built-in Research lane is read-only."
        },
        runtimeRoute: route("read-only"),
        workflow
      }
    ]
  };
}

function shipDepartment(now: string): Department {
  const workflow: WorkflowDefinition = {
    schemaVersion: 1,
    id: "department-ship-release-check",
    version: 1,
    name: "Ship release check",
    description: "Review release readiness, then pause before any consequential connector write.",
    steps: [
      {
        kind: "prompt",
        id: "check-local-state",
        prompt: "Review the local project context, known schedules, and recent notes for release blockers."
      },
      {
        kind: "connector-read",
        id: "read-vercel",
        connectorId: "vercel",
        capability: "vercel.deployment.read",
        input: { project: "{{project}}" },
        outputVar: "deployments"
      },
      {
        kind: "agent",
        id: "plan-ship",
        prompt: "Create a short ship plan with validation, rollback notes, and connector actions that need approval.",
        maxTurns: 4,
        requiresConnectors: ["vercel"]
      },
      {
        kind: "approval",
        id: "approve-connector-writes",
        description: "Approve any deployment, repository, notification, or calendar write before it leaves Fable."
      }
    ],
    notificationPrefs: {
      disableOs: false,
      enabledKinds: ["run-completed", "run-failed", "approval-needed"]
    },
    createdAt: now,
    updatedAt: now
  };
  return {
    id: "ship",
    name: "Ship",
    summary: "Check release readiness and stop at explicit approval before consequential writes.",
    pipelines: [
      {
        id: "ship-release-check",
        departmentId: "ship",
        name: "Release check",
        description: "A conservative shipping lane that plans first and gates external mutations.",
        steps: [
          {
            id: "ship-step-local",
            title: "Check local state",
            description: "Review project knowledge, schedules, and recent context.",
            workflowStepId: "check-local-state"
          },
          {
            id: "ship-step-deployments",
            title: "Read deployment state",
            description: "Use connected deployment metadata when available.",
            workflowStepId: "read-vercel"
          },
          {
            id: "ship-step-plan",
            title: "Draft ship plan",
            description: "Ask the selected AgentBackend for validation and rollback notes.",
            workflowStepId: "plan-ship"
          },
          {
            id: "ship-step-approval",
            title: "Pause for approval",
            description: "Require a fresh decision before connector writes.",
            workflowStepId: "approve-connector-writes"
          }
        ],
        connectorNeeds: [
          {
            connectorId: "vercel",
            access: "read",
            reason: "Deployment metadata helps confirm what is actually live."
          },
          {
            connectorId: "github",
            access: "write",
            reason: "Release notes, pull request comments, or workflow dispatches are consequential writes.",
            optional: true
          },
          {
            connectorId: "slack",
            access: "write",
            reason: "Team notifications are consequential writes.",
            optional: true
          }
        ],
        scheduleTrigger: {
          kind: "scheduled",
          description: "Can be run manually or attached to a local schedule before release windows."
        },
        approvalRequirement: {
          kind: "fresh-explicit",
          reason: "Connector writes remain prepared actions until the user approves the exact operation."
        },
        runtimeRoute: route("trusted-scope"),
        workflow
      }
    ]
  };
}
