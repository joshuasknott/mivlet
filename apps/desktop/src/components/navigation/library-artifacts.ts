import type {
  CollaborationWorkItem,
  LocalComputerArtifact,
} from "@mivlet/protocol";
import { parseComputerArtifact } from "../../lib/computer-artifacts";

/** Keep the first matching receipt per agent/artifact in native output order. */
export function collectLibraryArtifacts(
  work: readonly CollaborationWorkItem[],
  query: string,
) {
  const seen = new Set<string>();
  const result: {
    artifact: LocalComputerArtifact;
    output: string;
    agentId: string;
  }[] = [];
  for (const item of work) {
    for (const output of item.outputs) {
      const artifact = parseComputerArtifact(output.text);
      if (!artifact || !artifact.title.toLowerCase().includes(query)) continue;
      const key = JSON.stringify([item.agentId, artifact.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ artifact, output: output.text, agentId: item.agentId });
    }
  }
  return result;
}
