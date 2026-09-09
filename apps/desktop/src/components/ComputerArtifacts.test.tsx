import { act, fireEvent, render, screen } from "@testing-library/react";
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
});
