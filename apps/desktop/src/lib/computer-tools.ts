import type { NativeToolSpec, BackendModel, BackendProvider, BuiltinPlugins, LocalComputerSnapshot } from "@mivlet/protocol";
import { registeredToolSpecs } from "@mivlet/connectors/native-api/tools";
import { computerVisionUnavailableReason, supportsSharedComputerTools } from "@mivlet/connectors/native-api/computer-vision";
import type { DesktopToolExecutorOptions } from "./desktop-tool-options";

/** The same captured authority fence for file tools and native artifact egress. */
export function computerAuthorityCurrent(
  admitted: Partial<NonNullable<DesktopToolExecutorOptions["localComputer"]>> | undefined,
  current: DesktopToolExecutorOptions["localComputer"],
): boolean {
  return Boolean(admitted?.ready && admitted.controller === "agent" && Number.isSafeInteger(admitted.generation)
    && current?.ready && current.controller === "agent"
    && (["workspaceId", "agentId", "generation"] as const).every(key => current[key] === admitted[key]));
}

const COMPUTER_TOOLS = new Set([
  "repository-status", "repository-read", "repository-write", "repository-run", "repository-commit", "repository-publish", "repository-recover",
  "read-file", "write-file", "workspace-run", "create-spreadsheet", "create-document", "create-presentation", "create-pdf", "computer-artifact",
  "local-app-list", "local-app-select", "local-app-observe", "local-app-action",
  "local-browser-open", "local-browser-tabs", "local-browser-observe", "local-browser-navigate", "local-browser-click",
  "local-desktop-observe", "local-desktop-action",
  "generate-image", "edit-image",
]);
const IMAGE_TOOLS = new Set(["generate-image", "edit-image"]);

export function computerToolsReady(computer: LocalComputerSnapshot | null | undefined): boolean {
  return computer?.lifecycle === "ready" && computer.controller === "agent";
}

export function isLocalComputerTool(name: string, _argumentsJson: string): boolean {
  return COMPUTER_TOOLS.has(name);
}

/** Merge computer and connector tools without re-enabling unrelated runtimes. */
export function conversationComputerTools(connectedTools: NativeToolSpec[], ready: boolean, visualSupported = false, plugins: BuiltinPlugins = { computer: false }, imageApiConnected = false, runtimeAvailable = true): NativeToolSpec[] {
  const permitted = (name: string) => ready && (!IMAGE_TOOLS.has(name) || imageApiConnected) && plugins.computer && (visualSupported || !name.startsWith("local-desktop-")) && (runtimeAvailable || (!name.startsWith("local-app-") && !name.startsWith("local-desktop-") && !name.startsWith("local-browser-")));
  const tools = new Map(connectedTools.filter((tool) => (!tool.name.startsWith("local-browser") || COMPUTER_TOOLS.has(tool.name)) && tool.name !== "run-shell" && (!COMPUTER_TOOLS.has(tool.name) || permitted(tool.name))).map((tool) => [tool.name, tool]));
  for (const tool of registeredToolSpecs()) {
    if (tool.name === "web-fetch" || (COMPUTER_TOOLS.has(tool.name) && permitted(tool.name))) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

/** Both new turns and retries resolve tools against the model actually executing. */
export function conversationToolsForModel(connectedTools: NativeToolSpec[], ready: boolean, provider: BackendProvider | undefined, model: BackendModel | undefined, plugins?: BuiltinPlugins, imageApiConnected = false, runtimeAvailable = true): NativeToolSpec[] {
  // Codex owns subscription image generation. Never offer an automatic metered
  // API alternative on that route, even when an OpenAI API key is connected.
  const directImageApi = provider?.backendType !== "codex-app-server" && imageApiConnected;
  return conversationComputerTools(connectedTools, ready && supportsSharedComputerTools(provider) && model?.available === true, supportsComputerVision(provider, model), plugins, directImageApi, runtimeAvailable);
}

export function supportsComputerVision(provider: BackendProvider | undefined, model: BackendModel | undefined): boolean {
  return computerVisionUnavailableReason(provider, model) === null;
}
