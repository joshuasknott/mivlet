import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderContinuationControl } from "./ProviderContinuationControl";
import { previewProviderContinuation } from "../../runtime/domains/provider-continuation";
import { provider, model, continuation } from "../../test/provider-continuation-fixtures";

vi.mock("../../runtime/domains/provider-continuation", () => ({ previewProviderContinuation: vi.fn() }));
const preview = vi.mocked(previewProviderContinuation);
function props() {
  return { workspaceId: "default", ownerKey: "account:member", conversationId: "room", agentId: "lead", provider, model,
    prompt: "Continue exactly", disabled: false, attachmentCount: 0,
    prepare: vi.fn().mockResolvedValue(undefined), onContinue: vi.fn().mockResolvedValue(undefined) };
}
beforeEach(() => { vi.clearAllMocks(); preview.mockResolvedValue(continuation); });
describe("provider continuation review", () => {
  it("requires review and uses the exact native fingerprint", async () => {
    const p = props(); render(<ProviderContinuationControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with selected model…" }));
    await screen.findByRole("region", { name: "Provider continuation preview" });
    expect(screen.getByRole("region")).toHaveFocus();
    expect(p.onContinue).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Continue$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    await waitFor(() => expect(p.onContinue).toHaveBeenCalledWith(expect.objectContaining({ prompt: p.prompt, modelOptionId: model.id }), "fingerprint"));
  });
  it("discards an in-flight preview when the account/conversation/model/draft changes", async () => {
    let resolve!: (value: typeof continuation) => void;
    preview.mockImplementation(() => new Promise(r => { resolve = r; }));
    const p = props(); const view = render(<ProviderContinuationControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with selected model…" }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    view.rerender(<ProviderContinuationControl {...p} conversationId="other" />);
    await act(async () => resolve(continuation));
    expect(screen.queryByRole("region")).toBeNull();
  });
  it("restores focus after a preview failure so keyboard users can retry", async () => {
    preview.mockRejectedValue(new Error("History unavailable"));
    render(<ProviderContinuationControl {...props()} />);
    const trigger = screen.getByRole("button", { name: "Continue with selected model…" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toBeEnabled();
  });
  it("blocks active work and missing draft attachment availability", () => {
    const p = props(); const view = render(<ProviderContinuationControl {...p} disabled />);
    expect(screen.getByRole("button")).toBeDisabled();
    view.rerender(<ProviderContinuationControl {...p} attachmentCount={1} />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();
  });
  it("keeps the request when native admission rejects a stale preview", async () => {
    const p = props(); p.onContinue.mockRejectedValue(new Error("Saved context changed after preview."));
    render(<ProviderContinuationControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with selected model…" }));
    await screen.findByRole("checkbox");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved context changed");
    expect(screen.queryByRole("region")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue with selected model…" })).toHaveFocus());
  });
});
