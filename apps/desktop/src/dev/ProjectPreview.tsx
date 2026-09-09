import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { useRef, useState } from "react";
import type { FableAgentProfile } from "@fable/protocol";
import { WindowControls } from "../components/WindowControls";
import { AgentSidebar } from "../components/agents/AgentSidebar";
import { ProfileAgentAvatar } from "../components/agents/agent-icons";
import { Composer } from "../components/Composer";
import { ConversationFeed } from "../components/conversation/ConversationFeed";
import {
  ProjectEditor,
  ProjectFiles,
  ProjectInstructions,
  ProjectParticipants,
  ProjectWorkspace,
  type ProjectFileItem,
  type ProjectTab,
} from "../components/projects/ProjectWorkspace";
import type { NativeAgentState } from "../hooks/useNativeAgent";
import type { ConversationMessageView } from "../lib/conversation-runtime";
import type { ProviderModelOption } from "../lib/provider-models";
import "../shell/project-room.css";

const agents: FableAgentProfile[] = [
  {
    id: "ava",
    name: "Chief of Staff",
    iconColor: "#fc5b5f",
    instructions: "Bring the team's work together.",
    modelId: "codex::preview-model",
    icon: "agent",
    connectorIds: [],
    knowledgeSourceIds: [],
    permissionLabel: "Ask Me",
  },
  {
    id: "leo",
    name: "Leo",
    iconColor: "#1fc869",
    instructions: "Research and review copy.",
    modelId: "codex::preview-model",
    icon: "agent",
    connectorIds: [],
    knowledgeSourceIds: [],
    permissionLabel: "Ask Me",
  },
  {
    id: "maya",
    name: "Maya",
    iconColor: "#7250e8",
    instructions: "Refine design and layout.",
    modelId: "codex::preview-model",
    icon: "agent",
    connectorIds: [],
    knowledgeSourceIds: [],
    permissionLabel: "Ask Me",
  },
];
const models: ProviderModelOption[] = [
  {
    id: "codex::preview-model",
    modelId: "preview-model",
    label: "Example model",
    providerId: "codex",
    providerLabel: "ChatGPT",
    available: true,
    reasoning: { supportedEfforts: ["medium"], defaultEffort: "medium" },
  },
];
const initialFiles: ProjectFileItem[] = [
  {
    sourceId: "brief",
    name: "Brief.md",
    mediaType: "text/markdown",
    sizeBytes: 3072,
  },
  {
    sourceId: "copy",
    name: "Copy review.md",
    mediaType: "text/markdown",
    sizeBytes: 2048,
  },
  {
    sourceId: "hero",
    name: "Hero designs.png",
    mediaType: "image/png",
    sizeBytes: 1_258_291,
  },
];
const eligibleFiles: ProjectFileItem[] = [
  ...initialFiles,
  {
    sourceId: "checklist",
    name: "Launch checklist.md",
    mediaType: "text/markdown",
    sizeBytes: 4096,
  },
];

function message(
  runId: string,
  id: string,
  sequence: number,
  kind: "user" | "assistant",
  content: string,
): ConversationMessageView {
  const createdAt = `2026-09-07T09:${String(sequence * 5 + 2).padStart(2, "0")}:00.000Z`;
  return {
    message: {
      id,
      runId,
      threadId: "project-preview",
      sequence,
      kind,
      createdAt,
    },
    currentRevision: { state: "terminal", content, checkpointedAt: createdAt },
  } as ConversationMessageView;
}
const messages = [
  message("chief-run", "prompt", 0, "user", "Prepare the website for launch."),
  message(
    "chief-run",
    "chief-answer",
    1,
    "assistant",
    "Leo will check the copy. Maya will refine the layout. I’ll bring their work together.",
  ),
  message(
    "leo-run",
    "leo-answer",
    2,
    "assistant",
    "Copy looks clear and on brand. A few tightening suggestions are in **Copy review.md**.",
  ),
  message(
    "maya-run",
    "maya-answer",
    3,
    "assistant",
    "Updated the hero and mobile layout. The design file is ready for review in **Hero designs.png**.",
  ),
];
const emptyState: NativeAgentState = {
  transcript: "",
  running: false,
  status: "idle",
  lastError: null,
  noTransport: true,
  usage: null,
  contextReceipts: {},
  providerRoutes: {},
  usageReceipts: {},
  recoverableAttempts: [],
  reasoningSummaries: {},
  responseParts: [],
  currentAttemptId: null,
};

/** Development-only project-room sample. It never invokes a provider or native file operation. */
export function ProjectPreview() {
  const [projects, setProjects] = useState([
    {
      id: "website",
      name: "Website launch",
      instructions:
        "Prepare the public website for launch. Keep the copy concise and check the mobile layout.",
    },
    {
      id: "society",
      name: "Society events",
      instructions: "Plan and publish upcoming society events.",
    },
  ]);
  const [selectedId, setSelectedId] = useState("website");
  const [tab, setTab] = useState<ProjectTab>("conversation");
  const [files, setFiles] = useState(initialFiles);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [notice, setNotice] = useState(
    "Sample data. Nothing is sent or saved.",
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const composerRef =
    useRef<import("../components/ComposerInput").ComposerInputHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const project =
    projects.find((item) => item.id === selectedId) ?? projects[0];
  const authors = {
    "chief-run": agents[0],
    "leo-run": agents[1],
    "maya-run": agents[2],
  };
  const showConversation = selectedId === "website";

  const filePanel = (
    <ProjectFiles
      files={files}
      eligibleSources={eligibleFiles}
      onAttach={(sourceId) =>
        setFiles((current) => [
          ...current,
          eligibleFiles.find((file) => file.sourceId === sourceId)!,
        ])
      }
      onRemove={(sourceId) =>
        setFiles((current) =>
          current.filter((file) => file.sourceId !== sourceId),
        )
      }
      onImport={() =>
        setNotice("Importing files requires the native desktop app.")
      }
      onOpen={() =>
        setNotice("Opening project files requires the native desktop app.")
      }
    />
  );
  const conversation = (
    <div className="workspace-center workspace-center--composer workspace-center--conversation">
      <div className="conversation-scroll" aria-label="Conversation">
        <div className="conversation-feed">
          {showConversation ? (
            <ConversationFeed
              messages={messages}
              agent={agents[0]}
              authors={authors}
              requireAuthor
              state={emptyState}
              threadId="project-preview"
              profileName="Joshua"
              connectors={[]}
              optimisticPrompt=""
              workspaceId="preview-workspace"
              onPreviewArtifact={() =>
                setNotice(
                  "Opening generated files requires the native desktop app.",
                )
              }
            />
          ) : (
            <div className="project-room-empty">
              <h1>Start this project</h1>
              <p>Choose who should help, then send the first message.</p>
            </div>
          )}
        </div>
      </div>
      <div className="conversation-composer-dock">
        <Composer
          composerRef={composerRef}
          fileInputRef={fileRef}
          composerValue={messageText}
          onComposerChange={setMessageText}
          onSubmit={(event) => {
            event.preventDefault();
            if (messageText.trim()) {
              setMessageText("");
              setNotice("Preview only: no model request was sent.");
            }
          }}
          voiceStatus="unsupported"
          voiceMessage="Dictation is unavailable in this preview."
          voiceCanStart={false}
          voiceDisclosure="No microphone access is requested in the preview."
          voiceReview={null}
          onAuthorizeVoice={() => {}}
          onStartVoice={() => {}}
          onStopVoice={() => {}}
          onCancelVoice={() => {}}
          onDismissVoice={() => {}}
          onAttach={() =>
            setNotice("Attaching files requires the native desktop app.")
          }
          addMenuOpen={false}
          onImportRepository={() =>
            setNotice("Repository import requires the native desktop app.")
          }
          onToggleAddMenu={() => {}}
          onOpenTool={() =>
            setNotice("Plugins are available in the native desktop app.")
          }
          onRunCommand={() => {}}
          onFileChange={() => {}}
          models={models}
          selectedModelId={models[0].id}
          selectedModelLabel={models[0].label}
          onSelectModel={() => {}}
          connectedConnectors={[]}
          selectedReasoningEffort="medium"
          onSelectReasoningEffort={() => {}}
          placeholder="Message this project…"
          recipientControl={
            <ProjectParticipants
              agents={agents}
              recipientAgentId={recipient}
              onSelect={setRecipient}
            />
          }
          modelControl={
            recipient === null ? (
              <span className="project-room-models">Each agent’s model</span>
            ) : undefined
          }
          inThread
        />
      </div>
      <p className="project-room-disclosure">
        Project messages are visible to all agents.
      </p>
    </div>
  );

  return (
    <main
      className="desktop-frame desktop-frame--agents desktop-frame--project desktop-frame--live-closed"
      data-theme="light"
      data-mobile-view="conversation"
    >
      <WindowControls preview />
      <AgentSidebar
        agents={agents}
        activeAgentId=""
        previews={{
          ava: { message: "Project commander", time: "", status: "idle" },
          leo: { message: "Research agent", time: "", status: "idle" },
          maya: { message: "Design agent", time: "", status: "idle" },
        }}
        profileName="Joshua"
        connectors={[]}
        marketplaceActive={false}
        projects={projects}
        selectedProjectId={selectedId}
        onSelectProject={(item) => {
          setSelectedId(item.id);
          setTab("conversation");
        }}
        onCreateProject={() => {
          setEditingId(null);
          setEditorOpen(true);
        }}
        onSelectAgent={() =>
          setNotice(
            "Open the native desktop app to leave this project preview.",
          )
        }
        onCreateAgent={() =>
          setNotice("Open the native desktop app to create an agent.")
        }
        onEditAgent={() =>
          setNotice("Open the native desktop app to edit an agent.")
        }
        onOpenMarketplace={() =>
          setNotice("Open the native desktop app to manage plugins.")
        }
        onOpenSettings={() =>
          setNotice("Open the native desktop app to change settings.")
        }
        onOpenUsage={() => {}}
        onSignOut={() => {}}
      />
      <ProjectWorkspace
        name={project?.name ?? "Project"}
        activeTab={tab}
        onTabChange={setTab}
        headerActions={
          <button
            type="button"
            className="project-room-action"
            aria-label="Edit project"
            onClick={() => {
              setEditingId(project.id);
              setEditorOpen(true);
            }}
          >
            <DotsThree size={22} aria-hidden="true" />
          </button>
        }
        conversation={conversation}
        files={filePanel}
        instructions={
          <ProjectInstructions
            instructions={project?.instructions ?? ""}
            onSave={(instructions) => {
              setProjects((items) =>
                items.map((item) =>
                  item.id === project.id ? { ...item, instructions } : item,
                ),
              );
              setNotice("Instructions updated in this preview only.");
            }}
            status={notice}
          />
        }
        rail={
          <>
            <section
              className="project-room-agents"
              aria-label="Project agents"
            >
              <h2>Working here</h2>
              <div>
                {agents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    title={agent.name}
                    aria-label={`Ask ${agent.name}`}
                    onClick={() => setRecipient(agent.id)}
                  >
                    <ProfileAgentAvatar agent={agent} iconSize={30} />
                  </button>
                ))}
              </div>
            </section>
            <ProjectFiles
              compact
              files={files}
              eligibleSources={eligibleFiles}
              onAttach={(sourceId) =>
                setFiles((current) => [
                  ...current,
                  eligibleFiles.find((file) => file.sourceId === sourceId)!,
                ])
              }
              onRemove={(sourceId) =>
                setFiles((current) =>
                  current.filter((file) => file.sourceId !== sourceId),
                )
              }
              onImport={() =>
                setNotice("Importing files requires the native desktop app.")
              }
              onOpen={() =>
                setNotice(
                  "Opening project files requires the native desktop app.",
                )
              }
            />
            <button
              type="button"
              className="project-room-view-files"
              onClick={() => setTab("files")}
            >
              View all files
            </button>
          </>
        }
      />
      <ProjectEditor
        open={editorOpen}
        project={
          editingId
            ? (projects.find((item) => item.id === editingId) ?? null)
            : null
        }
        onClose={() => setEditorOpen(false)}
        onSave={(draft) => {
          if (editingId)
            setProjects((items) =>
              items.map((item) =>
                item.id === editingId ? { ...item, ...draft } : item,
              ),
            );
          else {
            const created = { id: crypto.randomUUID(), ...draft };
            setProjects((items) => [...items, created]);
            setSelectedId(created.id);
          }
          setEditorOpen(false);
          setNotice("Project updated in this preview only.");
        }}
        onArchive={
          editingId
            ? (id) => {
                const remaining = projects.filter((item) => item.id !== id);
                setProjects(remaining);
                setSelectedId(remaining[0]?.id ?? "");
                setEditorOpen(false);
                setNotice("Project removed from this preview only.");
              }
            : undefined
        }
      />
      <p className="project-room-status" role="status">
        {notice}
      </p>
    </main>
  );
}
