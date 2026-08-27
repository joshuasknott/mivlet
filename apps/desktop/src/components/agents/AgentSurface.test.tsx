import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FableAgentProfile } from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentSidebar } from "./AgentSidebar";
import { AgentWelcome } from "./AgentWelcome";
import { AgentTeamMissionDialog, buildAgentTeamMissionCommand } from "./AgentTeamMissionDialog";
import { AgentLearningDialog } from "./AgentLearningDialog";
import { AgentWorkspaceHeader } from "./AgentWorkspaceHeader";
import { LiveWorkRail } from "./LiveWorkRail";

function unavailableLocalComputer() {
  return {
    available: false,
    browserAvailable: false,
    browserActive: false,
    filesAvailable: false,
    files: null,
    filesLoading: false,
    filesError: null,
    controller: "agent" as const,
    loading: false,
    provisioning: false,
    busy: false,
    recoveryNeeded: false,
    error: null,
    generation: 0,
    onProvision: vi.fn().mockResolvedValue(null),
    onOpenBrowser: vi.fn().mockResolvedValue(null),
    onRefreshBrowser: vi.fn().mockResolvedValue(null),
    onRefreshFiles: vi.fn().mockResolvedValue(null),
    onTakeControl: vi.fn().mockResolvedValue(null),
    onReturnControl: vi.fn().mockResolvedValue(null),
    onClick: vi.fn().mockResolvedValue(null),
    onScroll: vi.fn().mockResolvedValue(null),
    onKey: vi.fn().mockResolvedValue(null)
  };
}
import { AgentAvatar, nextAgentColor } from "./agent-icons";
import { agentExecutionInstructions, suggestTeammateName } from "../../lib/agent-learning";

const chief: FableAgentProfile = {
  id: "chief-of-staff",
  name: "Chief of Staff",
  instructions: "Keep priorities clear.",
  modelId: "",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me"
};

const developer: FableAgentProfile = {
  ...chief,
  id: "developer",
  name: "Developer",
  icon: "agent",
  iconColor: "#3581FB"
};

describe("agent surface", () => {
  it("assigns the next unused colour while keeping one shared agent mark", () => {
    expect(nextAgentColor([chief.iconColor])).toBe(developer.iconColor);
    expect(chief.icon).toBe("agent");
    expect(developer.icon).toBe("agent");

    const { container } = render(
      <>
        <AgentAvatar color={chief.iconColor} />
        <AgentAvatar color={developer.iconColor} />
      </>
    );
    const marks = container.querySelectorAll('[data-agent-mark="fold"]');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.closest(".agent-avatar")).toHaveStyle({ "--agent-icon-base": chief.iconColor });
    expect(marks[1]?.closest(".agent-avatar")).toHaveStyle({ "--agent-icon-base": developer.iconColor });
  });

  it("keeps agents conversational and opens one workspace-wide search surface", () => {
    const onSelectAgent = vi.fn();
    const onCreateAgent = vi.fn();
    const onOpenSearch = vi.fn();
    render(
      <AgentSidebar
        agents={[chief, developer]}
        activeAgentId={chief.id}
        previews={{
          [chief.id]: { message: "Your priorities are ready", time: "Now", status: "running" },
          [developer.id]: { message: "Start a conversation", time: "", status: "idle" }
        }}
        profileName="Joshua"
        onSelectAgent={onSelectAgent}
        onCreateAgent={onCreateAgent}
        onOpenSearch={onOpenSearch}
        onEditAgent={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

    expect(screen.getByText("Your priorities are ready")).toBeVisible();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.queryByText("Fable")).not.toBeInTheDocument();
    expect(screen.queryByText("Ctrl K")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    expect(onCreateAgent).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Developer"));
    expect(onSelectAgent).toHaveBeenCalledWith(developer);
  });

  it("protects the sole agent and allows deletion once another agent exists", () => {
    const onDelete = vi.fn();
    const baseProps = {
      open: true,
      agent: chief,
      models: [],
      connectors: [],
      knowledgeSources: [],
      suggestedColor: "#2CC663",
      onClose: vi.fn(),
      onSave: vi.fn(),
      onDelete
    };
    const { rerender } = render(<AgentEditor {...baseProps} canDelete={false} />);

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Chief of Staff");
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Permissions" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Violet icon" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Upload image" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    rerender(<AgentEditor {...baseProps} canDelete />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("starts a new teammate through conversation before configuration", () => {
    const onChoose = vi.fn();
    render(
      <AgentWelcome
        agent={{ ...developer, name: "New teammate", instructions: "" }}
        onChoose={onChoose}
      />
    );

    expect(screen.getByText(/what do you want me around for/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Research and prepare briefs" }));
    expect(onChoose).toHaveBeenCalledWith("Research and prepare briefs");
    expect(suggestTeammateName("Research and prepare briefs")).toBe("Research Partner");
    expect(suggestTeammateName("Keep me on top of daily work")).toBe("Daily Coordinator");
    expect(suggestTeammateName("Manage investor updates")).toBe("Investor Updates");
    expect(suggestTeammateName("/goal Recruit two designers")).toBe("Talent Partner");
  });

  it("turns selected teammate roles into a bounded parallel mission", () => {
    const command = buildAgentTeamMissionCommand("Choose the safest launch path", [chief, developer]);
    expect(command).toContain("/mission Choose the safest launch path");
    expect(command).toContain("- Chief of Staff: Work from this teammate brief: Keep priorities clear.");
    expect(command).toContain("- Developer:");
    expect(command).toContain("all: Combine the teammates' work");
    expect(command).not.toBeNull();
  });

  it("launches a team mission without exposing command syntax in the dialog", () => {
    const onLaunch = vi.fn();
    render(
      <AgentTeamMissionDialog
        open
        agents={[chief, developer]}
        activeAgentId={chief.id}
        busy={false}
        onClose={vi.fn()}
        onLaunch={onLaunch}
      />
    );
    expect(screen.queryByText(/\/mission/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "What should the team accomplish?" }), {
      target: { value: "Prepare the launch recommendation" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start team mission" }));
    expect(onLaunch).toHaveBeenCalledWith(
      expect.stringContaining("/mission Prepare the launch recommendation"),
      "Prepare the launch recommendation"
    );
  });

  it("teaches a response as structured, future execution guidance", () => {
    const onChange = vi.fn();
    const onMakeRoutine = vi.fn();
    render(
      <AgentLearningDialog
        open
        agent={chief}
        source={{
          prompt: "Prepare a concise Friday launch update",
          response: "Launch is green. Two approvals remain."
        }}
        onClose={vi.fn()}
        onChange={onChange}
        onMakeRoutine={onMakeRoutine}
        onRun={vi.fn()}
      />
    );

    expect(screen.getByRole("textbox", { name: "Responsibility" })).toHaveValue(
      "Prepare a concise Friday launch update"
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /also make this a routine/i }));
    fireEvent.click(screen.getByRole("button", { name: "Teach task" }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Prepare a concise Friday launch update",
        instruction: "Prepare a concise Friday launch update"
      })
    ]);
    expect(onMakeRoutine).toHaveBeenCalledWith({
      title: "Prepare a concise Friday launch update",
      instruction: "Prepare a concise Friday launch update"
    });
  });

  it("makes learned work visible, editable, and removable", () => {
    const learned = {
      id: "learned-launch",
      title: "Launch update",
      instruction: "Summarize status, risks, and approvals.",
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z"
    };
    const onChange = vi.fn();
    const onRun = vi.fn();
    const { unmount } = render(
      <AgentLearningDialog
        open
        agent={{ ...chief, learnedTasks: [learned] }}
        source={null}
        onClose={vi.fn()}
        onChange={onChange}
        onMakeRoutine={vi.fn()}
        onRun={onRun}
      />
    );
    expect(screen.getByText("Launch update")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run Launch update" }));
    expect(onRun).toHaveBeenCalledWith(learned);
    fireEvent.click(screen.getByRole("button", { name: "Edit Launch update" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Responsibility" }), {
      target: { value: "Weekly launch update" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save responsibility" }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: learned.id, title: "Weekly launch update" })
    ]);
    unmount();

    render(
      <AgentLearningDialog
        open
        agent={{ ...chief, learnedTasks: [learned] }}
        source={null}
        onClose={vi.fn()}
        onChange={onChange}
        onMakeRoutine={vi.fn()}
        onRun={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Forget Launch update" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("includes learned responsibilities in individual and team work", () => {
    const trained = {
      ...developer,
      learnedTasks: [{
        id: "learned-review",
        title: "Review releases",
        instruction: "Check rollback evidence before recommending launch.",
        createdAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:00:00.000Z"
      }]
    };
    expect(agentExecutionInstructions(trained)).toContain("Review releases");
    expect(agentExecutionInstructions(trained)).toContain("Check rollback evidence");
    expect(buildAgentTeamMissionCommand("Ship safely", [chief, trained])).toContain("Review releases");
  });

  it("shows the learned-work count in the teammate header", () => {
    render(
      <AgentWorkspaceHeader
        agent={{ ...chief, learnedTasks: [{
          id: "learned-one",
          title: "Daily brief",
          instruction: "Summarize priorities.",
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: "2026-08-24T12:00:00.000Z"
        }] }}
        canTeamUp
        teamUpOpen={false}
        onTeamUp={vi.fn()}
        learnedCount={1}
        learnedOpen={false}
        onOpenLearned={vi.fn()}
        attentionCount={2}
        liveRailOpen={false}
        onToggleLiveRail={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Learned work, 1" })).toHaveAttribute(
      "title",
      "1 learned responsibility"
    );
    expect(screen.getByRole("button", { name: "Toggle live work, 2 needs attention" })).toHaveAttribute(
      "title",
      "2 approvals waiting"
    );
  });

  it("routes pending work directly to approval review", () => {
    const onReviewApprovals = vi.fn();
    render(
      <LiveWorkRail
        agentName="Chief of Staff"
        running={false}
        status="awaiting-approval"
        transcript="The venue is ready to book."
        runId="run-approval"
        approvalCount={2}
        computerUseActive={false}
        localComputer={unavailableLocalComputer()}
        hostedComputer={{
          available: false,
          runtimeActive: false,
          keepAlive: false,
          loading: false,
          provisioning: false,
          error: null,
          onProvision: vi.fn(),
          browserOpening: false,
          browserPhase: "idle",
          browserError: null,
          schedules: [],
          schedulesLoading: false,
          schedulesError: null,
          onOpenBrowser: vi.fn(),
          onRefreshBrowser: vi.fn()
        }}
        onReviewApprovals={onReviewApprovals}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Review 2 approvals" }));
    expect(onReviewApprovals).toHaveBeenCalledOnce();
  });

  it("opens an approved page from the ready cloud-computer card", async () => {
    const onOpenBrowser = vi.fn().mockResolvedValue({ currentUrl: "https://example.com/" });
    render(
      <LiveWorkRail
        agentName="Researcher"
        running={false}
        status="idle"
        transcript=""
        runId={null}
        approvalCount={0}
        computerUseActive={false}
        localComputer={unavailableLocalComputer()}
        hostedComputer={{
          available: true,
          status: "ready",
          runtimeActive: true,
          keepAlive: true,
          loading: false,
          provisioning: false,
          error: null,
          onProvision: vi.fn(),
          browserOpening: false,
          browserPhase: "idle",
          browserError: null,
          schedules: [{
            scheduleId: "schedule-digest-123",
            lifecycle: "active",
            nextRunAt: "2026-08-25T18:00:00.000Z"
          }],
          schedulesLoading: false,
          schedulesError: null,
          onOpenBrowser,
          onRefreshBrowser: vi.fn()
        }}
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Page to open on the cloud computer" }), {
      target: { value: "https://example.com/" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledWith("https://example.com/"));
    expect(screen.getByLabelText("Hosted schedules")).toHaveTextContent(
      "0 agent routines · 1 program schedule"
    );
  });

  it("sets up a separate local browser and takes control before user navigation", async () => {
    const onProvision = vi.fn().mockResolvedValue({ lifecycle: "ready" });
    const onTakeControl = vi.fn().mockResolvedValue({ controller: "human", generation: 2 });
    const onOpenBrowser = vi.fn().mockResolvedValue({ currentUrl: "https://example.com/" });
    const localComputer = {
      ...unavailableLocalComputer(),
      available: true,
      status: "ready" as const,
      browserAvailable: true,
      browserActive: true,
      browserProduct: "Microsoft Edge",
      controller: "agent" as const,
      generation: 1,
      viewport: { width: 1280, height: 800 },
      onProvision,
      onTakeControl,
      onOpenBrowser
    };
    render(
      <LiveWorkRail
        agentName="Researcher"
        running={false}
        status="idle"
        transcript=""
        runId={null}
        approvalCount={0}
        computerUseActive={false}
        localComputer={localComputer}
        hostedComputer={{
          available: false,
          runtimeActive: false,
          keepAlive: false,
          loading: false,
          provisioning: false,
          error: null,
          onProvision: vi.fn(),
          browserOpening: false,
          browserPhase: "idle",
          browserError: null,
          schedules: [],
          schedulesLoading: false,
          schedulesError: null,
          onOpenBrowser: vi.fn(),
          onRefreshBrowser: vi.fn()
        }}
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Page to open on this teammate's local computer" }), {
      target: { value: "https://example.com/" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(onTakeControl).toHaveBeenCalledOnce());
    await waitFor(() => expect(onOpenBrowser).toHaveBeenCalledWith("https://example.com/"));
    expect(screen.getByLabelText("Computer on this PC")).toHaveTextContent(
      "Microsoft Edge · separate profile and files"
    );
  });

  it("shows only relative metadata from the teammate's private files", async () => {
    const onRefreshFiles = vi.fn().mockResolvedValue(null);
    render(
      <LiveWorkRail
        agentName="Researcher"
        running={false}
        status="idle"
        transcript=""
        runId={null}
        approvalCount={0}
        computerUseActive={false}
        localComputer={{
          ...unavailableLocalComputer(),
          available: true,
          status: "ready",
          browserAvailable: true,
          filesAvailable: true,
          files: {
            computerId: "local-computer-a",
            entries: [
              { path: "notes", name: "notes", kind: "directory" },
              { path: "notes/plan.md", name: "plan.md", kind: "file", sizeBytes: 1_536 }
            ],
            truncated: false,
            updatedAt: "2026-08-27T12:00:00.000Z"
          },
          onRefreshFiles
        }}
        hostedComputer={{
          available: false,
          runtimeActive: false,
          keepAlive: false,
          loading: false,
          provisioning: false,
          error: null,
          onProvision: vi.fn(),
          browserOpening: false,
          browserPhase: "idle",
          browserError: null,
          schedules: [],
          schedulesLoading: false,
          schedulesError: null,
          onOpenBrowser: vi.fn(),
          onRefreshBrowser: vi.fn()
        }}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Files 2/ }));
    await waitFor(() => expect(onRefreshFiles).toHaveBeenCalledOnce());
    expect(screen.getByRole("region", { name: "Researcher's private files" })).toHaveTextContent("notes/plan.md");
    expect(screen.getByRole("region", { name: "Researcher's private files" })).toHaveTextContent("2 KB");
    expect(screen.queryByText(/AppData|local-computers|private plan/i)).not.toBeInTheDocument();
  });

  it("offers a restart when the local browser session loses contact", async () => {
    const onProvision = vi.fn().mockResolvedValue({ lifecycle: "ready" });
    render(
      <LiveWorkRail
        agentName="Researcher"
        running={false}
        status="idle"
        transcript=""
        runId={null}
        approvalCount={0}
        computerUseActive
        localComputer={{
          ...unavailableLocalComputer(),
          available: true,
          status: "ready",
          browserAvailable: true,
          browserActive: true,
          browserProduct: "Microsoft Edge",
          recoveryNeeded: true,
          error: "Fable could not capture the teammate browser.",
          onProvision
        }}
        hostedComputer={{
          available: false,
          runtimeActive: false,
          keepAlive: false,
          loading: false,
          provisioning: false,
          error: null,
          onProvision: vi.fn(),
          browserOpening: false,
          browserPhase: "idle",
          browserError: null,
          schedules: [],
          schedulesLoading: false,
          schedulesError: null,
          onOpenBrowser: vi.fn(),
          onRefreshBrowser: vi.fn()
        }}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("textbox", { name: "Page to open on this teammate's local computer" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onProvision).toHaveBeenCalledOnce());
  });
});
