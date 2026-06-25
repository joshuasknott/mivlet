import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

describe("Praxis home", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("writes a contextual directive into the composer", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /turn codex notes into a launch plan/i }));

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue(
      "Turn the Codex notes and PRD into a launch plan with milestones, risks, owner decisions, and the next three implementation steps."
    );
  });

  it("uses the lightweight Codex-like navigation hierarchy", () => {
    render(<App />);

    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /daily catch-up/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /initial build/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /memory and approvals/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /knowledge/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^home$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^threads$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /goals/i })).not.toBeInTheDocument();
  });

  it("opens knowledge as an inspectable workspace view", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getByRole("heading", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByText("Praxis product brief")).toBeInTheDocument();
    expect(screen.getByText("Selected design direction")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByText("Concise updates")).toBeInTheDocument();
  });

  it("records approval decisions without losing the second pending request", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    expect(screen.getByText("Create draft PR for feature-memory")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /^deny$/i })[0]);

    expect(screen.queryByText("Create draft PR for feature-memory")).not.toBeInTheDocument();
    expect(screen.getByText("Enable weekly workspace digest")).toBeInTheDocument();
    expect(screen.getByText(/deny: GitHub Create draft PR/i)).toBeInTheDocument();
  });

  it("turns slash commands into composer text", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /open slash commands/i }));
    await user.click(screen.getByRole("button", { name: "/goal" }));

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("/goal ");
  });

  it("imports local text files as pinned knowledge and contextual directives", async () => {
    const user = userEvent.setup();
    render(<App />);
    const file = new File(["Launch risks, connector recovery, and approval notes"], "launch-notes.md", {
      type: "text/markdown"
    });

    await user.upload(screen.getByLabelText(/import local knowledge file/i), file);

    expect(await screen.findByText(/Imported launch-notes.md/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /summarize launch-notes.md/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getByText("launch-notes.md")).toBeInTheDocument();
    expect(screen.getByText(/Local file -/i)).toBeInTheDocument();
  });

  it("shows citations from workspace sources when the composer is submitted", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/universal composer/i), "selected visual direction");
    await user.click(screen.getByRole("button", { name: /send prompt/i }));

    expect(await screen.findByText("Sources used")).toBeInTheDocument();
    expect(screen.getByText("Selected visual direction")).toBeInTheDocument();
    expect(screen.getByText("Product Design mockup - Updated today - trusted")).toBeInTheDocument();
  });

  it("recovers composer drafts from local persistence", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);

    await user.type(screen.getByLabelText(/universal composer/i), "Plan the onboarding journey");
    firstRender.unmount();
    render(<App />);

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("Plan the onboarding journey");
  });
});
