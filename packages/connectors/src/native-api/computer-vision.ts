import type { BackendModel, BackendProvider } from "@fable/protocol";
import { catalogueCapabilities, resolveModelCapabilities } from "./model-catalogue";

/** Image input and Mivlet tool execution must both exist on the actual route. */
export function supportsSharedComputerTools(provider: BackendProvider | undefined): boolean {
  if (provider?.authState !== "connected" || !provider.capabilities.includes("tool-requests")) return false;
  const driver = provider.driverKind;
  return (provider.backendType === "codex-app-server" && (!driver || driver === "codex"))
    || (provider.backendType === "native-api" && (!driver || driver === "native-api"));
}

/** Matches the audited native egress profiles, not arbitrary compatible hosts. */
export function supportsNativeComputerVision(providerId: string, model: BackendModel | undefined): boolean {
  if (!["openai", "anthropic", "xai"].includes(providerId) || !model?.available) return false;
  const catalogue = catalogueCapabilities(providerId, model.id);
  const resolved = resolveModelCapabilities(providerId, model);
  return catalogue?.vision === true && catalogue.tools === true
    && resolved?.vision === true && resolved.tools === true;
}

export function computerVisionUnavailableReason(provider: BackendProvider | undefined, model: BackendModel | undefined): string | null {
  if (provider?.authState !== "connected") return "Connect a provider before using screenshots.";
  if (!supportsSharedComputerTools(provider)) return "This provider route uses its own tools and has no Mivlet computer-tool response bridge. Screenshot control is unavailable on this route.";
  if (!model?.available) return "Select an available model before using screenshots.";
  if (provider.backendType === "codex-app-server") {
    return model.capabilities?.vision === true ? null : "This Codex model has not advertised image input. Screenshot control is unavailable.";
  }
  return supportsNativeComputerVision(provider.id, model) ? null
    : "This API route and model have no verified screenshot-and-tool protocol in Mivlet. Vision metadata alone does not enable screenshot control.";
}
