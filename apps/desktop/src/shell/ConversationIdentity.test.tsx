import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { ConversationIdentity } from "./ConversationIdentity";
const agent: MivletAgentProfile = { id: "mira", name: "Mira", icon: "agent", iconColor: "#865DFA", instructions: "", modelId: "", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" };
it.each(["Agent settings for Mira", "Project settings for Launch"])("opens %s from the avatar, name and keyboard as one control", async label => {
  const onOpen = vi.fn();
  render(<ConversationIdentity agent={agent} presence="idle" name={label.includes("Project") ? "Launch" : "Mira"} settingsLabel={label} disabled={false} sideChat={false} onOpen={onOpen} />);
  const button = screen.getByRole("button", { name: label });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(button.querySelector(".agent-avatar")!);
  fireEvent.click(button.querySelector("strong")!);
  button.focus();
  await userEvent.keyboard("{Enter} ");
  expect(onOpen).toHaveBeenCalledTimes(4);
});
it("keeps an unavailable agent disabled across the entire identity", () => {
  const onOpen = vi.fn();
  render(<ConversationIdentity agent={agent} presence="idle" name="Mira" settingsLabel="Agent settings for Mira" disabled sideChat onOpen={onOpen} />);
  fireEvent.click(screen.getByText("Mira"));
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole("button")).toBeDisabled();
  const marker = screen.getByText("Side Chat · separate conversation");
  expect(marker).toBeVisible();
  expect(marker.parentElement).toHaveClass("team-conversation-title");
  expect(marker.parentElement?.querySelector("button")).toBeDisabled();
});
