import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FableAgentProfile } from "@fable/protocol";
import { avatarVariant } from "../../lib/blob-avatar";
import { AgentEditor } from "./AgentEditor";

const profile: FableAgentProfile = {
  id: "agent-a", name: "Ava", instructions: "Keep it simple.", modelId: "", icon: "agent",
  iconColor: "#865DFA", avatarSeed: "blob-v1:ava", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me"
};
const props = { models: [], connectors: [], knowledgeSources: [], canDelete: false, onClose: vi.fn(), onDelete: vi.fn() };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("agent portrait ownership", () => {
  it("selects the new character's native colour and keeps recolouring separate from shape", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const view = render(<AgentEditor {...props} open agent={profile} onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Lens character" }));
    expect(screen.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector(".agent-editor__identity .agent-avatar")).toHaveAttribute("data-character", "1");
    await user.click(screen.getByRole("button", { name: "Orange" }));
    expect(screen.getByRole("button", { name: "Lens character" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ iconColor: "#FF994D", avatarSeed: expect.stringMatching(/^robot-v3:1:/) }));
  });
  it("previews and persists the selected colour through editing", async () => {
    const onSave = vi.fn();
    const view = render(<AgentEditor {...props} open agent={profile} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Mint" }));
    expect(view.container.querySelector(".agent-editor__identity linearGradient stop")).toHaveAttribute("stop-color", expect.any(String));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ iconColor: "#79E5C2" }));
    view.rerender(<AgentEditor {...props} open agent={onSave.mock.calls[0][0]} onSave={onSave} />);
    expect(screen.getByRole("button", { name: "Mint" })).toHaveAttribute("aria-pressed", "true");
  });
  it("saves the exact generated portrait shown during creation and gives the next agent a fresh seed", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const view = render(<AgentEditor {...props} open agent={null} onSave={onSave} />);
    const character = view.container.querySelector(".agent-editor__identity .agent-avatar")!;
    const firstCharacter = character.getAttribute("data-character");
    await user.type(screen.getByLabelText("Name"), "New agent");
    expect(character.getAttribute("data-character")).toBe(firstCharacter);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    const draft = onSave.mock.calls[0][0] as FableAgentProfile;
    expect(avatarVariant(draft.avatarSeed!)).toBe(Number(firstCharacter));
    view.rerender(<AgentEditor {...props} open={false} agent={null} onSave={onSave} />);
    view.rerender(<AgentEditor {...props} open agent={null} onSave={onSave} />);
    expect(view.container.querySelector(".agent-editor__identity .agent-avatar")!.getAttribute("data-character")).not.toBe(firstCharacter);
  });

  it("keeps an uploaded portrait until removal, then restores the same generated portrait", async () => {
    const user = userEvent.setup();
    const customImage = "data:image/png;base64,iVBORw0KGgo=";
    const onSave = vi.fn();
    const view = render(<AgentEditor {...props} open agent={{ ...profile, iconImageDataUrl: customImage }} onSave={onSave} />);
    expect(view.container.querySelector(".agent-editor__identity img")).toHaveAttribute("src", customImage);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Renamed agent");
    expect(view.container.querySelector(".agent-editor__identity img")).toHaveAttribute("src", customImage);
    await user.click(screen.getByRole("button", { name: "Remove image" }));
    expect(view.container.querySelector(".agent-editor__identity img")).toBeNull();
    expect(view.container.querySelector(".agent-editor__identity .agent-avatar")).toHaveAttribute("data-character", String(avatarVariant(profile.avatarSeed!)));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ avatarSeed: profile.avatarSeed, iconImageDataUrl: undefined, name: "Renamed agent" }));
  });

  it("normalizes uploaded images and prevents a late upload from replacing another agent's portrait", async () => {
    const user = userEvent.setup();
    const pendingImages: { onload: (() => void) | null }[] = [];
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      set src(_value: string) { pendingImages.push(this); }
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const customImage = "data:image/webp;base64,normalized";
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(customImage);
    const onSave = vi.fn();
    const view = render(<AgentEditor {...props} open agent={profile} onSave={onSave} />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "portrait.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload agent image"), file);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await waitFor(() => expect(pendingImages).toHaveLength(1));
    await act(async () => pendingImages[0].onload?.());
    expect(drawImage).toHaveBeenCalledWith(pendingImages[0], 100, 0, 600, 600, 0, 0, 256, 256);
    expect(view.container.querySelector(".agent-editor__identity img")).toHaveAttribute("src", customImage);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ avatarSeed: profile.avatarSeed, iconImageDataUrl: customImage }));

    await user.upload(screen.getByLabelText("Upload agent image"), file);
    await waitFor(() => expect(pendingImages).toHaveLength(2));
    const next = { ...profile, id: "agent-b", name: "Leo", avatarSeed: "blob-v1:leo" };
    view.rerender(<AgentEditor {...props} open agent={next} onSave={onSave} />);
    await act(async () => pendingImages[1].onload?.());
    expect(view.container.querySelector(".agent-editor__identity img")).toBeNull();
    expect(view.container.querySelector(".agent-editor__identity .agent-avatar")).toHaveAttribute("data-character", String(avatarVariant(next.avatarSeed)));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});

it("keeps character preview colours distinct when changing the selected colour", async () => {
  const user = userEvent.setup(); const onSave = vi.fn();
  const view = render(<AgentEditor {...props} open agent={profile} onSave={onSave} />);
  const variants = () => [...view.container.querySelectorAll('.agent-shape-picker > button .agent-avatar')].map((node) => node.getAttribute('data-character'));
  const before = variants();
  expect(new Set(before).size).toBe(8);
  await user.click(screen.getByRole("button", { name: "Cyan" }));
  expect(variants()).toEqual(before);
  expect(screen.queryByRole("button", { name: "Custom" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ iconColor: "#57D5F4" }));
});
