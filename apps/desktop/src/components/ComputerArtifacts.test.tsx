import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerArtifacts } from "./ComputerArtifacts";
import { parseComputerArtifact } from "../lib/computer-artifacts";

const native = vi.hoisted(() => ({ invoke: vi.fn(), available: true }));
vi.mock("../runtime/adapters/select", () => ({
  getRuntimeAdapter: () => ({ invoke: native.invoke }),
  hasNativeRuntimeAdapter: () => native.available,
}));
const artifact = {
  kind: "computer-artifact", version: 1, id: `artifact-${"a".repeat(64)}`, computerId: `local-${"b".repeat(24)}`,
  title: "Research report", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: 2048, relativePath: "reports/research.docx", createdAt: "2026-09-06T12:00:00Z",
};
const props = { output: JSON.stringify(artifact), workspaceId: "local", agentId: "agent-a", expectedGeneration: 7 };

describe("computer artifacts", () => {
  beforeEach(() => { native.available = true; native.invoke.mockReset().mockResolvedValue(undefined); });

  it("decodes persisted receipts and rejects unsafe output", () => {
    expect(parseComputerArtifact(props.output)).toEqual(artifact);
    for (const overrides of [{ relativePath: "../private.docx" }, { relativePath: "report.html" }, { relativePath: "a\\report.docx" }, { relativePath: "report.pdf", mimeType: "text/html" }, { mimeType: "text/html" }, { id: "some-path" }, { sizeBytes: 30 * 1024 * 1024 }, { title: "bad\u202eexe" }]) {
      expect(parseComputerArtifact(JSON.stringify({ ...artifact, ...overrides }))).toBeNull();
    }
    expect(parseComputerArtifact("ordinary tool output")).toBeNull();
  });

  it("offers PDF and presentation receipts while native validation remains authoritative", () => {
    for (const [extension, mimeType] of [["pdf", "application/pdf"], ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]]) {
      const receipt = { ...artifact, relativePath: `report.${extension}`, mimeType };
      expect(parseComputerArtifact(JSON.stringify(receipt))).toEqual(receipt);
    }
  });

  it("opens only an opaque receipt with current scope and generation", async () => {
    render(<ComputerArtifacts {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Research report" }));
    await act(async () => {});
    expect(native.invoke).toHaveBeenCalledWith("local_computer_open_artifact", { request: {
      workspaceId: "local", agentId: "agent-a", expectedGeneration: 7, artifactId: artifact.id,
    } });
    expect(screen.getByText("DOCX · 2 KB")).toBeTruthy();
  });

  it("does not offer unsupported or stale opens", () => {
    const view = render(<ComputerArtifacts {...props} expectedGeneration={undefined} />);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
    native.available = false;
    view.rerender(<ComputerArtifacts {...props} />);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
    view.rerender(<ComputerArtifacts {...props} output="not an artifact" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("shows native failures and suppresses late failure after scope changes", async () => {
    native.invoke.mockRejectedValueOnce(new Error("The published artifact has changed."));
    const view = render(<ComputerArtifacts {...props} />);
    fireEvent.click(screen.getByRole("button"));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("has changed");
    let reject: (reason: Error) => void = () => {};
    native.invoke.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure; }));
    fireEvent.click(screen.getByRole("button"));
    view.rerender(<ComputerArtifacts {...props} agentId="agent-b" expectedGeneration={8} />);
    view.rerender(<ComputerArtifacts {...props} />);
    await act(async () => { reject(new Error("Old computer failed.")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false);
  });

  const imageOutput = JSON.stringify({ ...artifact, title: "Ember logo", relativePath: "ember.png", mimeType: "image/png" });
  it.each([
    ["pdf", "application/pdf"], ["docx", artifact.mimeType],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["csv", "text/csv"], ["md", "text/markdown"], ["txt", "text/plain"],
  ])("routes %s file cards to the existing viewer without loading them automatically", (extension, mimeType) => {
    const output = JSON.stringify({ ...artifact, relativePath: `file.${extension}`, mimeType });
    const preview = vi.fn();
    render(<ComputerArtifacts {...props} output={output} onPreview={preview} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview Research report" }));
    expect(preview).toHaveBeenCalledWith(output);
    expect(native.invoke).not.toHaveBeenCalled();
  });
  const imagePreview = { artifactId: artifact.id, imageDataUrl: "data:image/png;base64,aGVsbG8=", text: null, mimeType: "image/png", truncated: false };
  it("shows a validated image inline and opens the existing viewer without opening an external app", async () => {
    native.invoke.mockResolvedValue(imagePreview);
    const preview = vi.fn();
    render(<ComputerArtifacts {...props} output={imageOutput} onPreview={preview} />);
    expect((await screen.findByRole("img", { name: "Ember logo" })).getAttribute("src")).toBe(imagePreview.imageDataUrl);
    expect(native.invoke).toHaveBeenCalledWith("local_computer_preview_artifact", { request: { workspaceId: "local", agentId: "agent-a", expectedGeneration: 7, artifactId: artifact.id } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Ember logo" }));
    expect(preview).toHaveBeenCalledWith(imageOutput);
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it("does not fetch image bytes for the compact viewer footer", () => {
    render(<ComputerArtifacts {...props} output={imageOutput} compact />);
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("discards loaded and pending images when scope changes", async () => {
    native.invoke.mockResolvedValueOnce(imagePreview);
    const view = render(<ComputerArtifacts {...props} output={imageOutput} />);
    await screen.findByRole("img");
    let finish!: (value: typeof imagePreview) => void;
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    view.rerender(<ComputerArtifacts {...props} output={imageOutput} agentId="agent-b" />);
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2));
    native.invoke.mockRejectedValueOnce(new Error("Unavailable"));
    view.rerender(<ComputerArtifacts {...props} output={imageOutput} agentId="agent-c" />);
    await act(async () => finish(imagePreview));
    await screen.findByText("Preview unavailable · Open file");
    expect(screen.queryByRole("img")).toBeNull();
  });
  it.each(["https://example.com/tracker.png", "data:image/svg+xml;base64,PHN2Zz4="])("does not load untrusted image URLs: %s", async imageDataUrl => {
    native.invoke.mockResolvedValue({ ...imagePreview, imageDataUrl });
    render(<ComputerArtifacts {...props} output={imageOutput} />);
    await screen.findByText("Preview unavailable · Open file");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
