import type { CollaborationWorkItem } from "@mivlet/protocol";
import { parseComputerArtifact } from "./computer-artifacts";
import { redactSecrets } from "./safe-output";

/** Sidebar subtitles are replies, never prompts or execution status. */
export function latestAgentReply(work: readonly CollaborationWorkItem[]): string {
  const latest = work.flatMap((item) => item.outputs)
    .filter((output) => output.text.trim() && !parseComputerArtifact(output.text))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest ? String(redactSecrets(latest.text)).replace(/\s+/g, " ").trim() : "";
}
