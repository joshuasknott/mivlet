import { startRuntimeStructuredIntake, type RuntimeMissionHumanInputRequest } from "../runtime";

const MAX_INTAKE_SUBJECT_LENGTH = 500;

export interface StructuredIntakeMissionInput {
  sourceThreadId: string;
  projectId?: string;
  subject: string;
  createStartKey?: () => string;
}

export async function startStructuredIntakeMission(
  input: StructuredIntakeMissionInput
): Promise<RuntimeMissionHumanInputRequest> {
  const subject = boundedSubject(input.subject);
  if (!subject) throw new Error("Structured intake needs a concise subject.");
  const request = await startRuntimeStructuredIntake({
    sourceThreadId: input.sourceThreadId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    subject,
    startKey: (input.createStartKey ?? secureStartKey)()
  });
  if (!request) throw new Error("Structured intake requires the desktop runtime.");
  return request;
}

/**
 * Conservative product entry for the provider-free structured-brief mission.
 * It deliberately avoids broad "brief" matching so ordinary prompts and the
 * connected-source cited benchmark keep their existing routes.
 */
export function structuredIntakeSubject(prompt: string): string | undefined {
  const value = prompt.trim();
  if (!value || value.length > 2_000) return undefined;
  const normalized = value.toLowerCase().replace(/\s+/g, " ");
  if (/\bconnected (?:work )?sources?\b/.test(normalized) || /\bcited\b/.test(normalized)) {
    return undefined;
  }

  const command = value.match(/^\/(?:intake|brief)(?:[ \t]+([^\r\n]+))?$/i);
  if (command) return boundedSubject(command[1] ?? "Structured project brief");

  const natural = value.match(
    /^(?:please\s+)?(?:help me\s+)?(?:create|make|structure|draft)\s+(?:me\s+)?a\s+structured\s+project\s+brief(?:\s+(?:for|about)\s+(.+))?[.!?]?$/is
  );
  if (!natural) return undefined;
  return boundedSubject(natural[1] ?? "Structured project brief");
}

export function isStructuredIntakeMissionPrompt(prompt: string): boolean {
  return structuredIntakeSubject(prompt) !== undefined;
}

function boundedSubject(value: string): string | undefined {
  const subject = value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  return subject && subject.length <= MAX_INTAKE_SUBJECT_LENGTH ? subject : undefined;
}

function secureStartKey(): string {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return `structured-intake-${Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("")}`;
}
