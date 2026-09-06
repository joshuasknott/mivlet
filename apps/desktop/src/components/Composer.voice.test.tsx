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
    permissionsOpen: false,
    onToggleAddMenu: vi.fn(),
    onTogglePermissions: vi.fn(),
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
    permissionLabel: "Full access",
    permissionProfiles: [],
    onSelectPermissionLabel: vi.fn(),
    ...overrides
  };
}

describe("Composer dictation controls", () => {
  it("keeps dictation and Send separate and only enables Send for text", () => {
    const { rerender } = render(
      <Composer {...propsFor("idle", { composerValue: "" })} />
    );

    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();

    rerender(<Composer {...propsFor("idle", { composerValue: "Draft reply" })} />);

    expect(screen.getByRole("button", { name: "Send prompt" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeEnabled();
  });

  it("treats whitespace-only drafts as empty", () => {
    render(<Composer {...propsFor("idle", { composerValue: "   " })} />);

    expect(screen.getByRole("button", { name: "Start dictation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Send prompt" })).toBeDisabled();
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
});
