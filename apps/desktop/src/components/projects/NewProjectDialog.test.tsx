import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { importLocalTextFile } from "@mivlet/connectors/local-files";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { NewProjectDialog } from "./NewProjectDialog";

const agents: MivletAgentProfile[] = Array.from({ length: 9 }, (_, index) => ({
  id: `agent-${index}`,
  name: index ? `Agent ${index}` : "Chief of Staff",
  instructions: "Help.",
  modelId: "codex::model",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
}));
const source = {
  ...importLocalTextFile({ name: "notes.md", content: "Plan", sizeBytes: 4 }),
  pinned: false,
};
const folder = {
  id: "folder-research",
  name: "Research",
  sources: [source],
  skippedCount: 2,
};
const setup = (props: Partial<Parameters<typeof NewProjectDialog>[0]> = {}) => {
  const onSave = vi.fn().mockResolvedValue(undefined),
    onClose = vi.fn();
  render(
    <NewProjectDialog
      agents={agents}
      onSave={onSave}
      onClose={onClose}
      {...props}
    />,
  );
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Launch" },
  });
  return { onSave, onClose };
};

describe("minimal project creation", () => {
  it("keeps the default surface concise and makes coordinator settings opt-in", () => {
    setup();
    expect(
      screen.getByRole("button", { name: "Remove Chief of Staff" }),
    ).toBeVisible();
    expect(screen.getByRole("combobox")).not.toBeVisible();
    screen
      .getAllByRole("checkbox")
      .forEach((checkbox) => expect(checkbox).not.toBeVisible());
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByText("More options"));
    expect(
      screen.getByRole("combobox", { name: "Coordinator Optional" }),
    ).toHaveValue("");
  });

  it("attaches imported folder sources only when the project is created and deduplicates them", async () => {
    const onImportSourceFolder = vi.fn().mockResolvedValue(folder);
    const { onSave, onClose } = setup({ onImportSourceFolder });
    fireEvent.click(screen.getByRole("button", { name: "Add source folder" }));
    expect(await screen.findByText("Research")).toBeVisible();
    expect(screen.getByText("1 file imported · 2 skipped")).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add source folder" }));
    await waitFor(() => expect(onImportSourceFolder).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getAllByText("Research")).toHaveLength(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeSourceIds: [source.id] }),
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("removes a folder from the project draft without deleting library knowledge", async () => {
    const { onSave } = setup({
      onImportSourceFolder: vi.fn().mockResolvedValue(folder),
    });
    fireEvent.click(screen.getByRole("button", { name: "Add source folder" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove folder Research" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeSourceIds: [] }),
      ),
    );
  });

  it("replaces a changed folder snapshot instead of attaching both revisions", async () => {
    const updated = { ...source, id: "updated-notes" };
    const onImportSourceFolder = vi
      .fn()
      .mockResolvedValueOnce(folder)
      .mockResolvedValueOnce({ ...folder, sources: [updated] });
    const { onSave } = setup({ onImportSourceFolder });
    fireEvent.click(screen.getByRole("button", { name: "Add source folder" }));
    await screen.findByText("Research");
    fireEvent.click(screen.getByRole("button", { name: "Add source folder" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add source folder" }),
      ).not.toBeDisabled(),
    );
    expect(screen.getAllByText("Research")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeSourceIds: [updated.id] }),
      ),
    );
  });

  it("handles picker cancellation and failure, blocks dismissal while importing, and allows retry", async () => {
    let finish!: (value: null) => void;
    const onImportSourceFolder = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("Folder unavailable."));
    const { onClose } = setup({ onImportSourceFolder });
    fireEvent.click(screen.getByRole("button", { name: "Add source folder" }));
    expect(
      screen.getByRole("button", { name: "Create project" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish(null));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add source folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder unavailable.",
    );
    expect(
      screen.getByRole("button", { name: "Add source folder" }),
    ).not.toBeDisabled();
  });

  it("caps the selected team at eight and closes only the agent picker on Escape", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText("Add", { selector: "summary" }));
    for (let index = 1; index < 8; index++)
      fireEvent.click(screen.getByRole("checkbox", { name: `Agent ${index}` }));
    expect(screen.getByRole("checkbox", { name: "Agent 8" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Agent 7" }), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
    screen
      .getAllByRole("checkbox")
      .forEach((checkbox) => expect(checkbox).not.toBeVisible());
  });

  it("clears the coordinator when that agent is removed and requires an agent before saving", async () => {
    const { onSave } = setup({
      initial: { participantIds: [agents[0].id], facilitatorId: agents[0].id },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Chief of Staff" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose one to eight agents.",
    );
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Agent 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          facilitatorId: "",
          participantIds: ["agent-1"],
        }),
      ),
    );
  });

  it("retains the form after a save failure and permits a successful retry", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not save."))
      .mockResolvedValueOnce(undefined);
    const { onClose } = setup({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveValue("Launch");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
