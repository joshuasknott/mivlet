import { parseComputerArtifact } from "./computer-artifacts";
import type { ResponsePart } from "./conversation-presentation-types";

/** Preserve the first successful receipt for each published artifact. */
export function publishedArtifactParts(parts: readonly ResponsePart[]) {
  const seen = new Set<string>();
  return parts.filter(
    (part): part is Extract<ResponsePart, { kind: "tool" }> => {
      if (part.kind !== "tool" || part.state !== "succeeded") return false;
      const artifact = parseComputerArtifact(part.content);
      if (!artifact || seen.has(artifact.id)) return false;
      seen.add(artifact.id);
      return true;
    },
  );
}
