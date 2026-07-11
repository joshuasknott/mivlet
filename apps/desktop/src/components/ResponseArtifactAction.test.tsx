import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ResponseArtifactAction } from "./ResponseArtifactAction";
import * as runtime from "../runtime";

vi.mock("../runtime", () => ({
  createRuntimeResponseArtifact: vi.fn(async () => ({
    artifact: { id: "artifact-1", title: "Answer", context: { threadId: "thread-1" } },
    version: { content: { kind: "inline", text: "Answer" }, citations: [{ id: "citation-1", label: "Roadmap" }] },
    sourceMessageId: "message-1"
  }))
}));

it("saves and opens a sourced assistant response", async () => {
  const onSaved = vi.fn();
  const { rerender } = render(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[{ sourceId: "source-1", title: "Roadmap", snippet: "Evidence" } as never]} onSaved={onSaved} />);
  await userEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(runtime.createRuntimeResponseArtifact).toHaveBeenCalledWith(expect.objectContaining({
    runId: "run-1",
    citations: [expect.objectContaining({ sourceId: "source-1" })]
  }));
  const saved = onSaved.mock.calls[0][0];
  rerender(<ResponseArtifactAction threadId="thread-1" messageId="message-1" runId="run-1" content="Answer" citations={[]} existing={saved} onSaved={onSaved} />);
  await userEvent.click(screen.getByRole("button", { name: "Hide artifact" }));
  await userEvent.click(screen.getByRole("button", { name: "View artifact" }));
  expect(screen.getByRole("region", { name: "Saved artifact" })).toHaveTextContent("Answer");
  expect(screen.getByRole("list", { name: "Artifact sources" })).toHaveTextContent("Roadmap");
});
