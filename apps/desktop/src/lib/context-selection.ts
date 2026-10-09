import type { CapturedWorkContext } from "@mivlet/protocol";

/** Read only the selection frozen by native Work admission, never mutable UI state. */
export function capturedFileExclusions(
  capture?: CapturedWorkContext,
): string[] {
  if (!capture) return [];
  const body: unknown = JSON.parse(capture.text);
  if (!body || typeof body !== "object" || !("contextSelection" in body))
    return [];
  const selection = body.contextSelection;
  if (
    !selection ||
    typeof selection !== "object" ||
    !("excludedKnowledgeSourceIds" in selection)
  )
    return [];
  const ids = selection.excludedKnowledgeSourceIds;
  if (
    !Array.isArray(ids) ||
    ids.length > 256 ||
    ids.some((id) => typeof id !== "string" || id.length > 512)
  )
    throw new Error(
      "The saved context selection is invalid. Review this request before continuing.",
    );
  return ids as string[];
}
