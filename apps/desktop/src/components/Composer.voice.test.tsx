import { createRef, type ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import type { VoiceStatus } from "../hooks/useVoice";

function propsFor(
  voiceStatus: VoiceStatus,
  overrides: Partial<ComponentProps<typeof Composer>> = {}
): ComponentProps<typeof Composer> {
  const unavailable =
    voiceStatus === "disabled" || voiceStatus === "unsupported";
  return {
    composerRef: createRef<import("./ComposerInput").ComposerInputHandle>(),
    fileInputRef: createRef<HTMLInputElement>(),
    composerValue: "Typed text stays",
    onComposerChange: vi.fn(),
    onSubmit: vi.fn(),
    voiceStatus,
    voiceMessage: `State: ${voiceStatus}`,
    voiceCanStart:
      !unavailable &&
      !["starting", "listening", "stopping", "processing"].includes(
        voiceStatus
      ),
    voiceDisclosure: "Mivlet does not retain raw audio.",
    onStartVoice: vi.fn(),
    onStopVoice: vi.fn(),
    onCancelVoice: vi.fn(),
    onDismissVoice: vi.fn(),
    onAttach: vi.fn(),
    addMenuOpen: false,
    onToggleAddMenu: vi.fn(),
    onOpenTool: vi.fn(),
    onRunCommand: vi.fn(),
    onFileChange: vi.fn(),
    models: [
      {
        id: "test",
        modelId: "test",
        providerId: "openai",
        providerLabel: "OpenAI",
        label: "Test",
        available: true
      }
    ],
    selectedModelId: "test",
    selectedModelLabel: "Test",
    onSelectModel: vi.fn(),
    ...overrides
  };
}

describe("Composer dictation controls", () => {
  it("keeps provider setup reachable beside the plus button when no model is available", () => {
    const onConnectProvider = vi.fn();
    render(<Composer {...propsFor("idle", { models: [], onConnectProvider })} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a provider" }));
    expect(onConnectProvider).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
  });
  it("keeps secondary controls in the menu and routes missing-provider setup", () => {
    const props = propsFor("idle", { secondaryControlsInMenu: true, models: [], addMenuOpen: true, onConnectProvider: vi.fn() });
    render(<Composer {...props} />);
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    expect(props.onStartVoice).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Connect a provider" }));
    expect(props.onConnectProvider).toHaveBeenCalledOnce();
  });

  it("opens model selection from secondary controls and restores focus on Escape", () => {
    const props = propsFor("idle", { secondaryControlsInMenu: true, addMenuOpen: true });
    render(<Composer {...props} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Model and reasoning…" }));
    expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Model and reasoning" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Model and reasoning" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add files and context" })).toHaveFocus();
  });

  it("keeps Stop and cancellation visible during compact dictation", () => {
    render(<Composer {...propsFor("listening", { secondaryControlsInMenu: true })} />);
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel dictation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send prompt" })).toBeNull();
  });
  it.each(["starting", "listening", "stopping", "reviewing", "processing"] as const)("blocks Enter during %s as well as form submission", (status) => {
    const props = propsFor(status);
    const view = render(<Composer {...props} />);
    fireEvent.keyDown(view.container.querySelector('[contenteditable="true"]')!, { key: "Enter" });
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("does not let Enter bypass Stop or submit whitespace", () => {
    const props = propsFor("idle", { isWorking: true });
    const view = render(<Composer {...props} />);
    fireEvent.keyDown(view.container.querySelector('[contenteditable="true"]')!, { key: "Enter" });
    expect(props.onSubmit).not.toHaveBeenCalled();
    view.rerender(<Composer {...props} isWorking={false} composerValue="   " />);
    fireEvent.keyDown(view.container.querySelector('[contenteditable="true"]')!, { key: "Enter" });
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("inserts a callable browser mention from keyboard completion", () => {
    const props = propsFor("idle", { composerValue: "@bro", connectedConnectors: [{ id: "browser", name: "Browser", status: "enabled" }] });
    const view = render(<Composer {...props} />);
    expect(screen.getByRole("option", { name: "Browser" })).toBeInTheDocument();
    fireEvent.keyDown(view.container.querySelector('[contenteditable="true"]')!, { key: "Tab" });
    expect(props.onComposerChange).toHaveBeenCalledWith("@browser ");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
  it("offers workspace agents with stable-ID chips and keyboard navigation", () => {
    const props = propsFor("idle", {
      composerValue: "@te",
      agentMentions: [
        { id: "test", name: "Test" },
        { id: "test-two", name: "Test" },
      ],
    });
    const view = render(<Composer {...props} />);
    expect(screen.getByRole("listbox", { name: "Workspace agents" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    const input = view.container.querySelector('[contenteditable="true"]')!;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onComposerChange).toHaveBeenCalledWith("@[Test](agent:test-two) ");
  });
  it("completes an @ token at the caret and preserves the text after it", () => {
    const props = propsFor("idle", {
      composerValue: "Before @te after",
      agentMentions: [{ id: "test", name: "Test" }],
    });
    const view = render(<Composer {...props} />);
    const input = view.container.querySelector('[contenteditable="true"]')!;
    props.composerRef.current!.setSelectionRange(10, 10);
    fireEvent.mouseUp(input);
    expect(screen.getByRole("listbox", { name: "Workspace agents" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onComposerChange).toHaveBeenCalledWith("Before @[Test](agent:test) after");
  });
  it("dismisses the workspace picker on Escape without changing the draft", () => {
    const props = propsFor("idle", { composerValue: "@te", agentMentions: [{ id: "test", name: "Test" }] });
    const view = render(<Composer {...props} />);
    fireEvent.keyDown(view.container.querySelector('[contenteditable="true"]')!, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Workspace agents" })).toBeNull();
    expect(props.onComposerChange).not.toHaveBeenCalled();
  });
  it("requires the recording upload decision and blocks typed submission while reviewing", () => {
    const props = propsFor("reviewing", { voiceReview: { recordingId: "recording", providerLabel: "OpenAI", model: "gpt-4o-mini-transcribe", durationMs: 4_000, sizeBytes: 1_024, mediaType: "audio/webm", maxDurationMs: 120_000 }, onAuthorizeVoice: vi.fn() });
    const view = render(<Composer {...props} />);
    fireEvent.submit(view.container.querySelector("form")!);
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Send prompt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upload & transcribe" }));
    expect(props.onAuthorizeVoice).toHaveBeenCalledOnce();
    expect(props.onStartVoice).not.toHaveBeenCalled();
  });
  it("keeps dictation beside Send and enables sending only with content", () => {
    const { rerender } = render(
      <Composer {...propsFor("idle", { composerValue: "" })} />
    );

    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start voice chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();

    rerender(<Composer {...propsFor("idle", { composerValue: "Draft reply" })} />);

    expect(screen.getByRole("button", { name: "Send prompt" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start voice chat" })).not.toBeInTheDocument();
  });

  it("treats whitespace-only drafts as empty", () => {
    render(<Composer {...propsFor("idle", { composerValue: "   " })} />);

    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start voice chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();
  });

  it("keeps attachment-only drafts sendable and keeps voice chat out of the action", () => {
    const onSubmit = vi.fn();
    const view = render(
      <Composer
        {...propsFor("idle", {
          composerValue: "",
          onSubmit,
          attachments: [{
            id: "attachment-1",
            name: "brief.txt",
            type: "text/plain",
            sizeBytes: 42,
            status: "Attached to this message",
          }],
        })}
      />
    );

    const send = screen.getByRole("button", { name: "Send prompt" });
    expect(send).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start voice chat" })).not.toBeInTheDocument();
    fireEvent.submit(view.container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("offers Send while working in-thread when only attachments are present", () => {
    render(
      <Composer
        {...propsFor("idle", {
          composerValue: "",
          isWorking: true,
          allowQueue: true,
          attachments: [{
            id: "attachment-1",
            name: "brief.txt",
            type: "text/plain",
            sizeBytes: 42,
          }],
        })}
      />
    );

    expect(screen.getByRole("button", { name: "Send prompt" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();
  });

  it("places dictation immediately before Send in the compact composer", () => {
    render(<Composer {...propsFor("idle", { composerValue: "", secondaryControlsInMenu: true })} />);
    const mic = screen.getByRole("button", { name: "Start dictation" });
    const send = screen.getByRole("button", { name: "Send prompt" });
    expect(mic.closest(".voice-actions")?.nextElementSibling).toBe(send);
    expect(send).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Start voice chat" })).toBeNull();
  });

  it("keeps Enter sending, Shift+Enter multiline and IME composition local", () => {
    const onSubmit = vi.fn();
    const view = render(
      <Composer {...propsFor("idle", { composerValue: "Typed text", onSubmit })} />
    );
    const input = view.container.querySelector('[contenteditable="true"]')!;

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("shows truthful listening controls while keeping typing available", () => {
    const props = propsFor("listening");
    render(<Composer {...props} />);

    expect(screen.getByRole("button", { name: "Stop dictation" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.getByRole("button", { name: "Cancel dictation" })
    ).toBeVisible();
    expect(screen.getByLabelText("Universal composer")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Send prompt" })).not.toBeInTheDocument();
    expect(screen.getByText("State: listening")).toBeInTheDocument();
    expect(document.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
  });

  it("marks startup as busy without claiming that listening is active", () => {
    render(<Composer {...propsFor("starting")} />);

    const button = screen.getByRole("button", { name: "Starting dictation" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Cancel dictation" })
    ).toBeVisible();
  });

  it.each(["stopping", "processing"] as const)(
    "marks %s as busy and keeps the draft editable",
    (status) => {
      render(<Composer {...propsFor(status)} />);

      expect(
        screen.getByRole("button", { name: "Processing dictation" })
      ).toHaveAttribute("aria-busy", "true");
      expect(screen.getByLabelText("Universal composer")).toBeEnabled();
      expect(screen.getByText(`State: ${status}`)).toBeInTheDocument();
    }
  );

  it.each(["disabled", "unsupported"] as const)(
    "keeps the %s explanation keyboard discoverable",
    (status) => {
      render(<Composer {...propsFor(status, { composerValue: "" })} />);

      const explanation = screen.getByRole("button", {
        name: `State: ${status}`
      });
      expect(explanation).toHaveAttribute("aria-disabled", "true");
      const descriptions = explanation.getAttribute("aria-describedby")!.split(" ");
      expect(descriptions).toHaveLength(2);
      expect(descriptions.map(id => document.getElementById(id)?.textContent)).toEqual([
        `State: ${status}`, "Mivlet does not retain raw audio."
      ]);
      expect(screen.getByLabelText("Universal composer")).toBeEnabled();
    }
  );

  it.each([
    "unavailable",
    "permission-denied",
    "error",
    "success",
    "cancelled"
  ] as const)("visually exposes and dismisses the %s state", (status) => {
    const onDismissVoice = vi.fn();
    render(
      <Composer
        {...propsFor(status, {
          onDismissVoice
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissVoice).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Universal composer")).toBeEnabled();
  });

  it("supports Escape cancellation only during an active voice operation", () => {
    const onCancelVoice = vi.fn();
    render(
      <Composer
        {...propsFor("listening", {
          onCancelVoice
        })}
      />
    );

    fireEvent.keyDown(screen.getByLabelText("Universal composer"), {
      key: "Escape"
    });
    expect(onCancelVoice).toHaveBeenCalledOnce();
  });
  it("exposes the model directly without approval configuration", () => {
    render(<Composer {...propsFor("idle")} />);
    expect(screen.getByRole("button", { name: /^Select model:/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approval preset" })).not.toBeInTheDocument();
  });
  it("keeps Stop available during work even with an empty draft", () => {
    const onStop = vi.fn();
    render(<Composer {...propsFor("idle", { composerValue: "", isWorking: true, onStop })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Start dictation" })).not.toBeInTheDocument();
  });

});

it("uses a keyboard-accessible plugin flyout and inserts connected app context", async () => {
  const onComposerChange = vi.fn(); const onToggleAddMenu = vi.fn();
  render(<Composer {...propsFor("idle", { addMenuOpen: true, composerValue: "Check", onComposerChange, onToggleAddMenu, connectedConnectors: [{ id: "gmail", name: "Gmail", status: "connected" }] })} />);
  const upload = screen.getByRole("menuitem", { name: "Upload files" });
  expect(upload).toHaveFocus();
  fireEvent.keyDown(upload, { key: "ArrowDown" });
  const plugins = screen.getByRole("menuitem", { name: "Plugins" });
  expect(plugins).toHaveFocus();
  fireEvent.keyDown(plugins, { key: "ArrowRight" });
  const gmail = screen.getByRole("menuitem", { name: "Gmail" });
  await vi.waitFor(() => expect(gmail).toHaveFocus());
  expect(screen.getAllByRole("menu")).toHaveLength(2);
  fireEvent.click(gmail);
  expect(onComposerChange).toHaveBeenCalledWith("Check @gmail ");
  expect(onToggleAddMenu).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "Attached plugins" })).toBeNull();
});
