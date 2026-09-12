import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { INITIAL_CONVERSATION_STATE } from "@fable/connectors/voice";
import { VoiceConversationView, type VoiceConversationViewProps } from "./VoiceConversationView";

function props(): VoiceConversationViewProps {
  return { agent: { id: "agent", name: "Ava", icon: "agent", iconColor: "#d37d67", instructions: "", modelId: "model", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" }, modelLabel: "Selected model", state: INITIAL_CONVERSATION_STATE, voice: "marin", onVoiceChange: vi.fn(), onStart: vi.fn(), onClose: vi.fn(), onMute: vi.fn(), onInterrupt: vi.fn(), onFinishTurn: vi.fn(), onOpenProviders: vi.fn() };
}
describe("voice call controls", () => {
  it("requires an explicit Start action after showing speech processing consent", async () => {
    const p = props(); render(<VoiceConversationView {...p} />);
    expect(p.onStart).not.toHaveBeenCalled();
    expect(screen.getByText(/sent to OpenAI for metered transcription/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start voice" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Start voice" })); expect(p.onStart).toHaveBeenCalledOnce();
  });
  it("offers provider setup without implying that ChatGPT includes API speech", async () => {
    const p = props(); render(<VoiceConversationView {...p} unavailable="OpenAI API is separate from ChatGPT." />);
    expect(screen.getByRole("button", { name: "Start voice" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Open Providers" })); expect(p.onOpenProviders).toHaveBeenCalledOnce();
  });
  it("keeps mute, interrupt, captions, and End keyboard accessible during playback", async () => {
    const p = props(); render(<VoiceConversationView {...p} state={{ ...p.state, phase: "speaking", userCaption: "Hello", agentCaption: "Hi there" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Mute microphone" })); expect(p.onMute).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Interrupt reply" })); expect(p.onInterrupt).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Show captions" })); expect(screen.queryByText("Hi there")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}"); expect(p.onClose).toHaveBeenCalledOnce();
  });
  it("keeps actual approval controls visible within the call", () => {
    const p = props(); const { container } = render(<VoiceConversationView {...p} state={{ ...p.state, phase: "thinking" }} approvals={<button>Approve exact action</button>} />);
    expect(screen.getByText("Your approval is needed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve exact action" })).toBeInTheDocument();
    expect(screen.getByText(/microphone is paused/)).toBeInTheDocument();
    expect(container.querySelector("[data-presence='waiting']")).toBeInTheDocument();
  });
});
