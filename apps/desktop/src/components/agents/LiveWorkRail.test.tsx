import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiveWorkRail } from "./LiveWorkRail";

vi.mock("./NativeComputerPanel", () => ({ NativeComputerPanel: () => null }));
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

describe("LiveWorkRail conversation navigation", () => {
  it("does not pass the click event as continuation draft content", () => {
    const onNewConversation = vi.fn();
    type Props = ComponentProps<typeof LiveWorkRail>;
    render(<LiveWorkRail
      agentName="Audit agent"
      localComputer={{} as Props["localComputer"]}
      hostedComputer={{ available: false } as Props["hostedComputer"]}
      onNewConversation={onNewConversation}
      onClose={() => undefined}
    />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(onNewConversation).toHaveBeenCalledExactlyOnceWith();
  });
});
