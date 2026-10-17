import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativePreviewDescriptor, NativePreviewFeedback, NativePreviewPick } from "@mivlet/protocol";
import { CodingPreview, isPreviewPick, validPreviewDescriptor } from "./CodingPreview";
const target = { workspaceId: "space", agentId: "atlas", expectedGeneration: 4, jobId: "job", jobGeneration: 4 };
const origin = `http://${"a".repeat(48)}.localhost:43210`;
const preview: NativePreviewDescriptor = { id: "preview", jobId: "job", jobGeneration: 4, repositoryId: "copy", generation: 4, revision: "revision", url: `${origin}/`, origin, expiresAt: new Date(Date.now() + 60_000).toISOString(), pickerSupported: true };
const pick: NativePreviewPick = { kind: "mivlet-preview-pick", previewId: "preview", jobId: "job", jobGeneration: 4, revision: "revision", path: "main > h1", tag: "h1", label: "Selected work", bounds: { x: 20, y: 40, width: 200, height: 50 } };
const feedback: NativePreviewFeedback = { ...pick, trust: "external-untrusted" };
function setup(descriptor = preview) {
  const props = { target, readPreview: vi.fn().mockResolvedValue({ status: "ready", preview: descriptor }), closePreview: vi.fn().mockResolvedValue({ status: "closed", message: "Closed by native." }), validatePreviewPick: vi.fn().mockResolvedValue(feedback), onDraft: vi.fn() };
  return { props, view: render(<CodingPreview {...props} />) };
}
const frame = () => screen.getByTitle("Running project preview") as HTMLIFrameElement;
function guest(data: unknown, eventOrigin = origin, source: MessageEventSource | null = frame().contentWindow) { fireEvent(window, new MessageEvent("message", { origin: eventOrigin, source, data })); }
const ready = () => guest({ kind: "mivlet-preview-ready", previewId: "preview", jobId: "job", jobGeneration: 4, revision: "revision" });
afterEach(cleanup);
describe("native running-app preview", () => {
  it("rejects arbitrary ports, origins, expired capabilities and stale generations", () => {
    expect(validPreviewDescriptor(preview, target)).toBe(true);
    for (const invalid of [{ ...preview, url: "http://127.0.0.1:3000/", origin: "http://127.0.0.1:3000" }, { ...preview, origin: "https://other.example" }, { ...preview, expiresAt: "2000-01-01" }, { ...preview, generation: 3 }]) expect(validPreviewDescriptor(invalid, target)).toBe(false);
    expect(isPreviewPick({ ...pick, bounds: { ...pick.bounds, width: Infinity } }, preview)).toBe(false);
  });
  it("requires exact guest readiness and native validation before drafting feedback", async () => {
    const { props } = setup(); await screen.findByTitle("Running project preview");
    fireEvent.load(frame());
    const picker = screen.getByRole("button", { name: "Pick an element" });
    expect(picker).toBeDisabled(); ready(); expect(picker).toBeEnabled();
    fireEvent.click(picker);
    guest(pick, "https://other.example"); guest(pick, origin, window); guest({ ...pick, revision: "stale" });
    expect(props.validatePreviewPick).not.toHaveBeenCalled();
    guest(pick); await screen.findByRole("textbox", { name: "Change selected h1" });
    expect(props.validatePreviewPick).toHaveBeenCalledWith({ ...target, previewId: "preview" }, pick);
    expect(props.onDraft).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Make the heading smaller and give it more space." } });
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
    expect(props.onDraft).toHaveBeenCalledWith(expect.stringContaining("Make the heading smaller"));
    expect(props.onDraft).toHaveBeenCalledWith(expect.stringContaining("untrusted page content"));
    expect(frame()).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
  });
  it("renders an unavailable native state without an iframe or synthetic URL", async () => {
    render(<CodingPreview target={target} readPreview={async () => ({ status: "unavailable", message: "This session has no approved preview port." })} closePreview={vi.fn()} validatePreviewPick={vi.fn()} onDraft={vi.fn()} />);
    await screen.findByText("This session has no approved preview port.");
    expect(screen.queryByTitle("Running project preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pick an element" })).toBeNull();
  });
  it("discards late element evidence after a native session change", async () => {
    const { props, view } = setup();
    let finish!: (value: NativePreviewFeedback) => void;
    props.validatePreviewPick.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await screen.findByTitle("Running project preview"); fireEvent.load(frame()); ready();
    fireEvent.click(screen.getByRole("button", { name: "Pick an element" })); guest(pick);
    await screen.findByText("Checking the selected element…");
    view.rerender(<CodingPreview {...props} target={{ ...target, agentId: "mira" }} />);
    finish(feedback);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Change selected h1" })).toBeNull());
    expect(props.onDraft).not.toHaveBeenCalled();
  });
  it("closes only the exact native preview without claiming the command stopped", async () => {
    const { props } = setup(); await screen.findByTitle("Running project preview");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await screen.findByText("Closed by native.");
    expect(props.closePreview).toHaveBeenCalledWith({ ...target, previewId: "preview" });
    expect(screen.queryByTitle("Running project preview")).toBeNull();
  });
});
