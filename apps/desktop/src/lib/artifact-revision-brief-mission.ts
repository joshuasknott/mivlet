import { startRuntimeArtifactRevisionBrief, type RuntimeMissionHumanInputRequest } from "../runtime";

const MAX_FOCUS_LENGTH = 500;

export interface ArtifactRevisionBriefMissionInput {
  sourceThreadId: string;
  projectId?: string;
  focus?: string;
  createStartKey?: () => string;
}

export async function startArtifactRevisionBriefMission(
  input: ArtifactRevisionBriefMissionInput
): Promise<RuntimeMissionHumanInputRequest> {
  const focus = input.focus ? boundedFocus(input.focus) : undefined;
  if (input.focus && !focus) throw new Error("Artifact revision brief needs a concise focus.");
  const request = await startRuntimeArtifactRevisionBrief({
    sourceThreadId: input.sourceThreadId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(focus ? { focus } : {}),
    startKey: (input.createStartKey ?? secureStartKey)()
  });
  if (!request) throw new Error("Artifact revision brief requires the desktop runtime.");
  return request;
}

/** Narrow provider-free entry; ordinary requests to edit an artifact remain prompts. */
export function artifactRevisionBriefFocus(prompt: string): string | undefined {
  const value = prompt.trim();
  if (!value || value.length > 2_000) return undefined;
  const command = value.match(/^\/(?:revision-brief|revise-brief)(?:[ \t]+([^\r\n]+))?$/i);
  if (command) return boundedFocus(command[1] ?? "Artifact revision brief");
  const natural = value.match(
    /^(?:please\s+)?(?:help me\s+)?(?:create|make|draft)\s+(?:me\s+)?an?\s+artifact\s+revision\s+brief(?:\s+(?:for|about)\s+(.+))?[.!?]?$/is
  );
  if (!natural) return undefined;
  return boundedFocus(natural[1] ?? "Artifact revision brief");
}

function boundedFocus(value: string): string | undefined {
  const focus = value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  return focus && focus.length <= MAX_FOCUS_LENGTH ? focus : undefined;
}

function secureStartKey(): string {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return `artifact-revision-brief-${Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("")}`;
}
