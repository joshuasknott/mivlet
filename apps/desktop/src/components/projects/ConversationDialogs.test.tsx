import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { ConversationDialog, MigrateGroupDialog } from "./ConversationDialogs";

const agents: MivletAgentProfile[] = ["Chief", "Product", "Researcher"].map(name => ({
  id: name.toLowerCase(), name, instructions: "Help with this project.",
  modelId: "codex::gpt-5.6-luna", icon: "agent", iconColor: "#865DFA",
  connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me",
}));

describe("conversation participants", () => {
  it("creates a project team without a coordinator and keeps explicit participants", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ConversationDialog agents={agents} initial={{ kind: "project" }} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Launch" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Chief" }));
    expect(screen.getByRole("combobox", { name: "Coordinator Optional" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          participantIds: ["chief"],
          facilitatorId: "",
        }),
      ),
    );
  });

  it("replaces an automatic participant while retaining explicitly selected people", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ConversationDialog agents={agents} initial={{ kind: "project" }} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Launch" } });
    fireEvent.change(screen.getByLabelText("Coordinator Optional"), { target: { value: "product" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Chief" }));
    fireEvent.change(screen.getByLabelText("Coordinator Optional"), { target: { value: "researcher" } });
    expect(screen.getByRole("checkbox", { name: "Chief" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Product" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Researcher Coordinator" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          participantIds: ["chief", "researcher"],
          facilitatorId: "researcher",
        }),
      ),
    );
  });

  it("retains the existing team when clearing an established coordinator", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationDialog
        agents={agents}
        edit
        initial={{ kind: "project", title: "Launch", participantIds: ["chief", "product"], facilitatorId: "chief" }}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Coordinator Optional"), { target: { value: "" } });
    expect(screen.getByRole("checkbox", { name: "Chief" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Product" })).toBeChecked();
    expect(screen.getByText(/No coordinator is designated/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ facilitatorId: "", participantIds: ["chief", "product"] }),
      ),
    );
  });
});

describe("legacy group migration", () => {
  it("requires explicit history consent and submits the new team", async () => {
    const onMigrate = vi.fn().mockResolvedValue(undefined);
    render(
      <MigrateGroupDialog
        title="Old room"
        agents={agents}
        initialParticipantIds={["chief", "product"]}
        onMigrate={onMigrate}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("Project name")).toHaveValue("Old room project");
    fireEvent.click(screen.getByRole("button", { name: "Convert to project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Confirm sharing the existing history",
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Share the existing history and authorship/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Convert to project" }));
    await waitFor(() =>
      expect(onMigrate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Old room project",
          participantIds: ["chief", "product"],
          leadAgentId: "",
        }),
      ),
    );
  });
});
