import type { WorkflowStep } from "@fable/protocol";
import type { ConnectorAccountSession, ConnectorRuntime } from "../sdk";

export interface WorkflowConnectorBoundary {
  runtime: ConnectorRuntime;
  sessionFor(connectorId: string): ConnectorAccountSession | undefined;
}

/**
 * Adapts workflow connector tasks to the existing credential-owning
 * ConnectorRuntime. Workflow persistence receives only redacted responses;
 * credentials remain inside the connector session/runtime boundary.
 */
export function createWorkflowConnectorRead(boundary: WorkflowConnectorBoundary) {
  return async (
    step: Extract<WorkflowStep, { kind: "connector-read" }>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const session = boundary.sessionFor(step.connectorId);
    if (!session) {
      throw workflowConnectorError(
        "connector-not-connected",
        `${step.connectorId} must be connected before this task can run.`
      );
    }
    return boundary.runtime.read(session, {
      capability: step.capability,
      input: step.input,
      signal
    });
  };
}

export function createWorkflowConnectorWrite(boundary: WorkflowConnectorBoundary) {
  return async (
    step: Extract<WorkflowStep, { kind: "connector-write" }>,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const session = boundary.sessionFor(step.connectorId);
    if (!session) {
      throw workflowConnectorError(
        "connector-not-connected",
        `${step.connectorId} must be connected before this task can run.`
      );
    }
    return boundary.runtime.write(session, {
      capability: step.capability,
      input: step.input,
      target: step.target,
      preview: step.preview,
      riskLevel: step.riskLevel,
      runId: idempotencyKey,
      idempotencyKey,
      signal
    });
  };
}

function workflowConnectorError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
