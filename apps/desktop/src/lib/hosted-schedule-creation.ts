import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import type { ApprovalGate } from "@fable/connectors/native-api/tool-executor";
import type {
  ApprovalRequest,
  ApprovalResolutionRequest,
  HostedProcessScheduleDraft,
  HostedProcessScheduleSnapshot
} from "@fable/protocol";
import {
  createRuntimeHostedProcessSchedule,
  prepareRuntimeHostedProcessSchedule
} from "../runtime";
import type { HostedScheduleCancellationScope } from "./hosted-schedule-cancellation";

export interface HostedScheduleFormInput {
  label: string;
  programPath: string;
  arguments: string[];
  firstRunAt: string;
  intervalSeconds: number;
}

interface HostedScheduleCreationDependencies {
  gate: ApprovalGate;
  queueApproval: (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => void;
  prepare?: typeof prepareRuntimeHostedProcessSchedule;
  create?: typeof createRuntimeHostedProcessSchedule;
  now?: () => string;
}

export function hostedScheduleDraftFromForm(
  scope: HostedScheduleCancellationScope,
  input: HostedScheduleFormInput,
  id: () => string = () => crypto.randomUUID().replace(/-/gu, "")
): HostedProcessScheduleDraft {
  const label = input.label.trim();
  const program = normalizeHostedProgramPath(input.programPath);
  const firstRun = new Date(input.firstRunAt);
  if (!label || label.length > 80 || !Number.isFinite(firstRun.getTime())) {
    throw new Error("Add a short name and a valid first run time.");
  }
  const firstRunAt = firstRun.toISOString();
  if (
    !Number.isInteger(input.intervalSeconds)
    || input.intervalSeconds < 300
    || input.intervalSeconds > 604_800
  ) {
    throw new Error("Choose a repeat interval between five minutes and seven days.");
  }
  if (
    input.arguments.length > 32
    || input.arguments.some((argument) => !argument || argument.length > 2_000 || /[\u0000-\u001f\u007f]/u.test(argument))
  ) {
    throw new Error("Use at most 32 visible, non-empty program arguments.");
  }
  const token = id().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 40);
  if (token.length < 8) throw new Error("Fable could not create a safe schedule identity.");
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "program";
  return {
    ...scope,
    scheduleId: `schedule-${token}`,
    runId: `scheduled-${slug}-${token.slice(0, 8)}`,
    argv: [interpreterFor(program), program, ...input.arguments],
    cwd: "/workspace",
    timeoutMs: 15 * 60_000,
    firstRunAt,
    intervalSeconds: input.intervalSeconds
  };
}

/** Human-created schedules use the same source and exact native proposal
 * approvals as a model-created cloud-process-schedule call. */
export async function createHostedScheduleWithApprovals(
  draft: HostedProcessScheduleDraft,
  dependencies: HostedScheduleCreationDependencies
): Promise<HostedProcessScheduleSnapshot> {
  const prepare = dependencies.prepare ?? prepareRuntimeHostedProcessSchedule;
  const create = dependencies.create ?? createRuntimeHostedProcessSchedule;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const argumentsJson = JSON.stringify({
    scheduleId: draft.scheduleId,
    runId: draft.runId,
    argv: draft.argv,
    cwd: draft.cwd,
    timeoutMs: draft.timeoutMs,
    firstRunAt: draft.firstRunAt,
    intervalSeconds: draft.intervalSeconds
  });
  const sourceApproval = buildToolApproval("fable-ui", "cloud-process-schedule", argumentsJson);
  dependencies.queueApproval({
    callId: sourceApproval.id,
    tool: "cloud-process-schedule",
    arguments: argumentsJson,
    approval: sourceApproval
  });
  if (await dependencies.gate.waitForDecision(sourceApproval) !== "granted") {
    throw new Error("Always-on schedule creation was denied.");
  }
  const sourceResolution: ApprovalResolutionRequest = {
    request: sourceApproval,
    decision: "once",
    decidedAt: now(),
    confirmationText: sourceApproval.confirmationPhrase
  };
  const prepared = await prepare(draft);
  if (!prepared) throw new Error("Always-on schedule creation requires the desktop runtime.");
  dependencies.queueApproval({
    callId: prepared.approval.id,
    tool: "cloud-process-schedule",
    arguments: argumentsJson,
    approval: prepared.approval
  });
  if (await dependencies.gate.waitForDecision(prepared.approval) !== "granted") {
    throw new Error("Always-on schedule creation was denied.");
  }
  const resolution: ApprovalResolutionRequest = {
    request: prepared.approval,
    decision: "once",
    decidedAt: now(),
    confirmationText: prepared.approval.confirmationPhrase
  };
  const snapshot = await create(prepared.proposal, resolution, sourceResolution);
  if (!snapshot) throw new Error("Always-on schedule creation requires the desktop runtime.");
  return snapshot;
}

function normalizeHostedProgramPath(value: string): string {
  const relative = value.trim().replace(/^\/workspace\//u, "");
  if (
    !relative
    || relative.length > 240
    || relative.includes("\\")
    || relative.split("/").some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/u.test(segment))
  ) {
    throw new Error("Choose a program path below /workspace using letters, numbers, dots, dashes, or underscores.");
  }
  return `/workspace/${relative}`;
}

function interpreterFor(program: string): string {
  if (/\.(?:mjs|cjs|js)$/iu.test(program)) return "node";
  if (/\.py$/iu.test(program)) return "python3";
  if (/\.sh$/iu.test(program)) return "sh";
  throw new Error("Always-on form programs must be .js, .mjs, .cjs, .py, or .sh files.");
}
