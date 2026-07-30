import {
  importLocalTextFile,
  validateLocalFileCandidate
} from "@fable/connectors/local-files";
import type {
  LocalFileImport,
  LocalKnowledgeRefreshResponse,
  RefreshLocalKnowledgeSourceRequest
} from "@fable/protocol";

export async function buildLocalKnowledgeRefreshRequest(
  source: LocalFileImport,
  file: File
): Promise<RefreshLocalKnowledgeSourceRequest> {
  const content = await file.text();
  return {
    sourceId: source.id,
    expectedContentFingerprint: source.contentFingerprint,
    file: {
      name: file.name,
      content,
      sizeBytes: file.size,
      selectedAt: new Date().toISOString(),
      ...(file.lastModified > 0 ? { modifiedAt: new Date(file.lastModified).toISOString() } : {})
    }
  };
}

export function applyLocalKnowledgeRefresh(
  source: LocalFileImport,
  request: RefreshLocalKnowledgeSourceRequest
): LocalKnowledgeRefreshResponse {
  if (request.sourceId.trim() !== source.id ||
      request.expectedContentFingerprint.trim() !== source.contentFingerprint) {
    throw new Error("This source changed elsewhere. Reload Knowledge and try again.");
  }
  if (source.deletedAt) throw new Error("Deleted knowledge cannot be refreshed.");
  if (source.kind !== "document" || source.connectorId !== "local-files" ||
      source.origin !== "local-import" || source.trust !== "untrusted") {
    throw new Error("Only local file imports can be refreshed.");
  }
  const basename = request.file.name.trim().split(/[\\/]/).pop() ?? "";
  if (request.file.name.trim() !== basename || basename !== source.title) {
    throw new Error(`Choose the current version of ${source.title}.`);
  }
  if (!request.file.selectedAt.trim()) throw new Error("Refresh needs a selection time.");
  const candidate = {
    name: basename,
    content: request.file.content,
    sizeBytes: request.file.sizeBytes,
    importedAt: request.file.selectedAt,
    modifiedAt: request.file.modifiedAt
  };
  const validation = validateLocalFileCandidate(candidate);
  if (!validation.ok) throw new Error(validation.message);
  const imported = importLocalTextFile(candidate);
  if (imported.contentFingerprint === source.contentFingerprint) {
    return { outcome: "unchanged", source };
  }
  return {
    outcome: "updated",
    source: {
      ...source,
      contentPreview: imported.contentPreview,
      contentFingerprint: imported.contentFingerprint,
      sizeBytes: imported.sizeBytes,
      importedAt: request.file.selectedAt,
      ...(request.file.modifiedAt ? { modifiedAt: request.file.modifiedAt } : {}),
      provenance: imported.provenance,
      freshness: "Refreshed now",
      mediaType: imported.mediaType,
      status: "ok",
      statusMessage: undefined
    }
  };
}
