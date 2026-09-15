import type { SearchRequest, SearchResponse } from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

/** Unified scoped search requires the installed desktop runtime: results are
 * decrypted native reads and a browser preview has no account store. */
export async function searchWorkspace(
  request: SearchRequest,
): Promise<SearchResponse> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview")
    throw new Error("Search requires the installed desktop app.");
  try {
    return await adapter.invoke<SearchResponse>("search_workspace", {
      request,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}
