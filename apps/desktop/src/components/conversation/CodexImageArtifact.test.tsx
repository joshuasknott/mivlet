import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import type { NativeAgentState } from "../../hooks/useNativeAgent";
import { ConversationFeed } from "./ConversationFeed";

it("shows a Codex image outside collapsed activity and opens its preview", () => {
  const agent: MivletAgentProfile = {
    id: "agent", name: "Chief of Staff", icon: "agent", iconColor: "#24bb77",
    instructions: "", modelId: "", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me",
  };
  const output = JSON.stringify({
    kind: "computer-artifact", version: 1, id: `artifact-${"a".repeat(64)}`,
    computerId: `local-${"b".repeat(24)}`, title: "Generated image", mimeType: "image/png",
    sizeBytes: 1024, relativePath: "generated/logo.png", createdAt: "2026-09-17T12:00:00Z",
  });
  const state: NativeAgentState = {
    transcript: "Here is your logo.", usage: null, running: false, lastError: null,
    status: "completed", recoverableAttempts: [], contextReceipts: {}, providerRoutes: {}, usageReceipts: {},
    currentAttemptId: "run-1", noTransport: false, progressThreadId: "thread-1", progressPrompt: "Create a logo",
    responseParts: [
      { id: "image-1", kind: "tool", tool: "codex-image-generation", state: "succeeded", content: output },
      { id: "answer", kind: "text", content: "Here is your logo." },
    ],
  };
  const onPreviewArtifact = vi.fn();
  render(<ConversationFeed agent={agent} messages={[]} state={state} threadId="thread-1"
    profileName="You" connectors={[]} optimisticPrompt="" workspaceId="workspace" generation={1}
    onPreviewArtifact={onPreviewArtifact} />);
  const preview = screen.getByRole("button", { name: "Preview Generated image" });
  expect(preview).toBeVisible();
  fireEvent.click(preview);
  expect(onPreviewArtifact).toHaveBeenCalledWith(output, agent.id);
});
