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
    voiceDisclosure: "Fable does not retain raw audio.",
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
  it("inserts a callable browser mention from keyboard completion", () => {
    const props = propsFor("idle", { composerValue: "@bro", connectedConnectors: [{ id: "browser", name: "Browser", status: "enabled" }] });
    const view = render(<Composer {...props} />);
    expect(screen.getByRole("option", { name: "Browser" })).toBeInTheDocument();
    fireEvent.keyDown(view.container.querySelector('[contenteditable="true"]')!, { key: "Tab" });
    expect(props.onComposerChange).toHaveBeenCalledWith("@browser ");
    expect(props.onSubmit).not.toHaveBeenCalled();
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
  it("switches between dictation and Send using trimmed text", () => {
    const { rerender } = render(
      <Composer {...propsFor("idle", { composerValue: "" })} />
    );

    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send prompt" })).not.toBeInTheDocument();

    rerender(<Composer {...propsFor("idle", { composerValue: "Draft reply" })} />);

    expect(screen.getByRole("button", { name: "Send prompt" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start dictation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeEnabled();
  });

  it("treats whitespace-only drafts as empty", () => {
    render(<Composer {...propsFor("idle", { composerValue: "   " })} />);

    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send prompt" })).not.toBeInTheDocument();
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
      expect(explanation).toHaveAttribute(
        "aria-describedby",
        "dictation-status dictation-disclosure"
      );
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
    expect(screen.getByRole("button", { name: "Select model" })).toBeInTheDocument();
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

it("uses one keyboard-accessible menu and inserts connected app context", () => {
  const onComposerChange = vi.fn(); const onToggleAddMenu = vi.fn();
  render(<Composer {...propsFor("idle", { addMenuOpen: true, composerValue: "Check", onComposerChange, onToggleAddMenu, connectedConnectors: [{ id: "gmail", name: "Gmail", status: "connected" }] })} />);
  const upload = screen.getByRole("menuitem", { name: "Upload files" });
  expect(upload).toHaveFocus();
  fireEvent.keyDown(upload, { key: "ArrowDown" });
  const gmail = screen.getByRole("menuitem", { name: "Gmail" });
  expect(gmail).toHaveFocus();
  fireEvent.click(gmail);
  expect(onComposerChange).toHaveBeenCalledWith("Check @gmail ");
  expect(onToggleAddMenu).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("menu")).toHaveLength(1);
});
