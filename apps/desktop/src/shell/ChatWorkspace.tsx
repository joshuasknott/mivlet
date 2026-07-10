import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { parseComposerText } from "@fable/connectors";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { connectors, projects } from "../data/workspace";
import { utilityItems } from "../lib/constants";
import {
  buildAgentRequest,
  PERMISSION_PROFILES,
  validateModelSelection
} from "../lib/agent-run";
import { insertDictation } from "../lib/insert-dictation";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { Composer } from "../components/Composer";
import { ConnectorIcon } from "../components/ConnectorIcon";
import { CitationResults, DirectiveCards } from "../components/workspace-cards";
import { tabs as settingsTabs } from "../components/pages/settings-tabs";
import type { SettingsTab } from "../components/pages/settings-tabs";
import { composerModelsFor } from "./composer-models";
import { ShellPageBoundary } from "./ShellRoutes";
import { useShellAgentController } from "./useShellAgentController";

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

function messageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
// Standalone pages are code-split: each is only rendered when navigated to, so
// loading them lazily keeps the initial workspace bundle small. Named exports
// are adapted to the lazy() default-export contract via `.then`. Suspense
// fallbacks are minimal (no layout shift) â€” the heaviest of these (Settings)
// pulls in Run History, Schedule panel, and provider rendering on demand.
const OnboardingPage = lazy(() =>
  import("../components/pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage }))
);
const SettingsPage = lazy(() =>
  import("../components/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const WorkspaceSettingsView = lazy(() =>
  import("../components/pages/SettingsPage").then((m) => ({ default: m.WorkspaceSettingsView }))
);
const ApprovalPanel = lazy(() =>
  import("../components/ApprovalPanel").then((m) => ({ default: m.ApprovalPanel }))
);

/**
 * Root composition for the Fable desktop shell.
 *
 * useShellRuntime owns runtime/data state and effects. This component owns
 * shell-local UI state (collection expansion, the account popover, tool/command
 * picker visibility) and routes between chat views and the standalone
 * Connectors / Knowledge / Schedules pages. The composer renders only on chat
 * views.
 */

/** Presentation and interaction boundary for the active desktop workspace. */
export function ChatWorkspace() {
  // The shared approval gate: the shell's grant/deny decisions resolve it, and
  // the agent-loop executor awaits it. Created once before the hooks so both
  // useShellRuntime (dispatch on grant/deny) and useNativeAgent (executor awaits
  // it) share the same instance â€” a grant in the approval UI drives the tool call
  // the loop is currently blocked on.
  const [selectedConversationThreadId, setSelectedConversationThreadId] = useState<string>();
  const controller = useShellAgentController({ onDictation: addDictationToComposer, onVoiceCancel: focusComposerAfterVoice, threadId: selectedConversationThreadId });
  const { runtime, agent, durableConversation, voice, scheduledActive, resetCancellation } = controller;
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[]>([]);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const draftHydrationKey = useRef<string | null>(null);
  const activeAssistantMessageId = useRef<string | null>(null);
  const boundWorkspaceId =
    runtime.accountWorkspaceStatus.accountBound &&
    (runtime.accountWorkspaceStatus.state === "ready" ||
      runtime.accountWorkspaceStatus.state === "offline")
      ? runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId
      : null;
  const conversationWorkspaceId = useRef<string | null>(boundWorkspaceId);
  const projectFolderInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceName = runtime.accountWorkspaceStatus.activeWorkspace.name || "Fable workspace";
  const verifiedProfile = useMemo(() => {
    const display = runtime.identityStatus.authentication?.verifiedDisplayAttributes;
    return { name: display?.displayName ?? display?.email ?? "Fable account", email: display?.email ?? "" };
  }, [runtime.identityStatus.authentication]);
  // Re-sync the shell's standing grants into the gate so session/rule grants
  // auto-satisfy matching tool calls without re-prompting.
  // The real executor: awaits the gate, then runs the granted tool through the
  // Rust boundary (which re-validates the approval and performs the side effect).
  // Cooperative cancellation: a cancel flag the agent hook's shouldCancel reads.
  // The cancel() path flips it true so an in-flight loop bails between events;
  // the real-Rust cancel (cancelRuntimeCompletion) still drops the socket. This
  // is the cooperative layer on top of the Rust boundary drop.
  const [expandedCollections, setExpandedCollections] = useState({
    projects: true,
    chats: true
  });
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    fable: true,
    site: false
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const storedTheme = window.localStorage.getItem("fable-theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme;
    }

    return "light";
  });

  useEffect(() => {
    window.localStorage.setItem("fable-theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [previousActiveItem, setPreviousActiveItem] = useState("new-chat");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("general");
  const [settingsModalSearch, setSettingsModalSearch] = useState("");
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceSettingsStatus, setWorkspaceSettingsStatus] = useState("");
  const navigationHistory = useRef([runtime.activeItem]);
  const navigationTarget = useRef<string | null>(null);
  const [navigationIndex, setNavigationIndex] = useState(0);

  useEffect(() => {
    if (boundWorkspaceId === null) {
      if (conversationWorkspaceId.current === null) {
        return;
      }

      void agent.cancel();
      setSelectedConversationThreadId(undefined);
      activeAssistantMessageId.current = null;
      setConversationMessages([]);
      navigationHistory.current = [runtime.activeItem];
      setNavigationIndex(0);
      conversationWorkspaceId.current = null;
      return;
    }

    // Establishing the first authoritative workspace is hydration, not a switch.
    // Clearing here would cancel recovery work started while account status loads.
    if (conversationWorkspaceId.current === null) {
      conversationWorkspaceId.current = boundWorkspaceId;
      return;
    }

    if (conversationWorkspaceId.current !== boundWorkspaceId) {
      void agent.cancel();
      setSelectedConversationThreadId(undefined);
      activeAssistantMessageId.current = null;
      setConversationMessages([]);
      navigationHistory.current = [runtime.activeItem];
      setNavigationIndex(0);
      conversationWorkspaceId.current = boundWorkspaceId;
    }
  }, [agent.cancel, boundWorkspaceId, runtime.activeItem]);

  useEffect(() => {
    if (navigationTarget.current === runtime.activeItem) {
      navigationTarget.current = null;
    } else if (navigationHistory.current[navigationIndex] !== runtime.activeItem) {
      const nextHistory = navigationHistory.current.slice(0, navigationIndex + 1);
      nextHistory.push(runtime.activeItem);
      navigationHistory.current = nextHistory;
      setNavigationIndex(nextHistory.length - 1);
    }

    if (runtime.activeItem !== "Settings" && runtime.activeItem !== "Profile") {
      setPreviousActiveItem(runtime.activeItem);
    }
  }, [navigationIndex, runtime.activeItem]);

  useEffect(() => {
    if (runtime.activeItem === "Profile") {
      setActiveSettingsTab("general");
    }
    if (runtime.runHistoryJobId && runtime.activeItem === "Settings") {
      setActiveSettingsTab("history");
    }
  }, [runtime.activeItem, runtime.runHistoryJobId]);

  // Connected connectors shown on the home rail. Real provider marks only;
  // local-files is always available so it is not surfaced as a connector. If
  // nothing is connected, the rail renders nothing. Memoized so the rail and
  // the composer prop keep a stable reference across unrelated re-renders.
  const connectedConnectorCards = useMemo(
    () =>
      runtime.connectorManifests.filter(
        (connector) => connector.status === "connected" && connector.id !== "local-files"
      ),
    [runtime.connectorManifests]
  );
  const composerModels = useMemo(
    () => composerModelsFor(runtime.connectedAgentBackend?.id, runtime.modelOptions),
    [runtime.connectedAgentBackend?.id, runtime.modelOptions]
  );
  // The picker stores provider-qualified ids (for example `openai::gpt-5`),
  // while the agent backend must receive the provider's original model id
  // (`gpt-5`). Keep the two values distinct so model selection stays collision
  // safe without sending the UI key to a provider.
  const resolvedComposerModelOptionId = useMemo(() => {
    if (
      runtime.selectedModelId &&
      composerModels.some((model) => model.id === runtime.selectedModelId)
    ) {
      return runtime.selectedModelId;
    }
    return composerModels[0]?.id ?? runtime.resolvedModelOptionId;
  }, [composerModels, runtime.resolvedModelOptionId, runtime.selectedModelId]);
  const resolvedComposerModelId = useMemo(
    () =>
      composerModels.find((model) => model.id === resolvedComposerModelOptionId)?.modelId ??
      runtime.resolvedSelectedModelId,
    [composerModels, resolvedComposerModelOptionId, runtime.resolvedSelectedModelId]
  );

  const appendConversationMessage = (role: ConversationMessage["role"], content: string) => {
    const id = messageId(role);
    setConversationMessages((current) => [...current, { id, role, content }]);
    return id;
  };

  const durableThreads = useMemo(
    () => durableConversation.state.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      kind: thread.projectId ? "project" as const : "chat" as const,
      description: thread.projectId ? "Project conversation" : "Workspace conversation",
      updatedAt: thread.updatedAt,
      pinnedContextIds: []
    })),
    [durableConversation.state.threads]
  );

  useEffect(() => {
    const hydrated = durableConversation.state.conversation;
    if (!selectedConversationThreadId || !hydrated || hydrated.thread.id !== selectedConversationThreadId) {
      if (!selectedConversationThreadId) setConversationMessages([]);
      return;
    }
    if (hydrated.messages.length === 0 && (pendingPrompt || agent.state.running)) return;
    setConversationMessages(hydrated.messages.map(({ message, currentRevision }) => ({
      id: message.id,
      role: message.kind === "user" ? "user" : "assistant",
      content: currentRevision.state === "redacted" ? "This message was removed." : currentRevision.content
    })));
  }, [agent.state.running, durableConversation.state.conversation, pendingPrompt, selectedConversationThreadId]);

  useEffect(() => {
    if (durableConversation.state.loading || submissionInFlight) return;
    if (draftHydrationKey.current === durableConversation.draftKey) return;
    draftHydrationKey.current = durableConversation.draftKey;
    runtime.setComposerValue(durableConversation.state.draft?.content ?? "");
  }, [durableConversation.draftKey, durableConversation.state.draft, durableConversation.state.loading, runtime.setComposerValue, submissionInFlight]);

  useEffect(() => {
    if (draftHydrationKey.current !== durableConversation.draftKey) return;
    const timer = window.setTimeout(() => {
      if (runtime.composerValue) void durableConversation.saveDraft(runtime.composerValue);
      else void durableConversation.deleteDraft();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [durableConversation.deleteDraft, durableConversation.draftKey, durableConversation.saveDraft, runtime.composerValue]);

  useEffect(() => {
    if (!pendingPrompt || !selectedConversationThreadId) return;
    const prompt = pendingPrompt;
    setPendingPrompt(null);
    void continueComposerSubmission(prompt).finally(() => setSubmissionInFlight(false));
  }, [pendingPrompt, selectedConversationThreadId]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !agent.state.running) void durableConversation.refresh();
    wasRunning.current = agent.state.running;
  }, [agent.state.running, durableConversation.refresh]);

  useEffect(() => {
    const assistantId = activeAssistantMessageId.current;
    if (!assistantId) return;
    const fallback =
      agent.state.status === "awaiting-approval"
        ? "Waiting for approval."
        : agent.state.running
          ? "Working..."
          : agent.state.lastError
            ? agent.state.lastError
            : "";
    const content = agent.state.transcript || fallback;
    setConversationMessages((current) =>
      current.map((message) =>
        message.id === assistantId ? { ...message, content } : message
      )
    );
    if (!agent.state.running && agent.state.status !== "streaming" && agent.state.status !== "awaiting-approval") {
      activeAssistantMessageId.current = null;
    }
  }, [agent.state.lastError, agent.state.running, agent.state.status, agent.state.transcript]);

  // Recoverable runs scoped to the active thread. Hoisted + memoized so the
  // agent panel does not re-filter the full recoverable list on every render
  // (agent text deltas re-render App frequently).
  const activeThreadId = runtime.activeThread?.id ?? runtime.activeItem;
  const visibleRecoverableRuns = useMemo(
    () =>
      agent.state.recoverableRuns.filter(
        (run) => !run.threadId || run.threadId === activeThreadId
      ),
    [agent.state.recoverableRuns, activeThreadId]
  );

  // The sidebar highlights the active item's spinner while an agent run is in
  // flight. Memoized so the prop keeps a stable array reference (the previous
  // inline ternary allocated a fresh array every render).
  const loadingItemIds = useMemo(
    () => (agent.state.running && runtime.activeItem ? [runtime.activeItem] : []),
    [agent.state.running, runtime.activeItem]
  );

  const renderConversation = () => {
    if (conversationMessages.length === 0) return null;
    return (
      <section className="conversation-feed" aria-label="Conversation">
        {conversationMessages.map((message) => (
          <article
            key={message.id}
            className={`conversation-message conversation-message--${message.role}`}
          >
            <p>{message.content}</p>
          </article>
        ))}
      </section>
    );
  };

  const renderChatContext = () => {
    const visibleAgentError = agent.state.noTransport ? null : agent.state.lastError;

    return (
      <>
        {connectedConnectorCards.length > 0 ? (
          <div className="connector-rail" aria-label="Connected connectors">
            {connectedConnectorCards.map((connector) => (
              <button
                key={connector.id}
                type="button"
                className={`connector-pill connector-pill--${connector.id}`}
                onClick={() => {
                  const prompt = `Use @${connector.id} to `;
                  runtime.setComposerValue(prompt);
                  runtime.focusComposer(prompt);
                }}
              >
                <ConnectorIcon id={connector.id} />
                <span>{connector.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        {runtime.openApprovals.length > 0 ||
        runtime.editingApprovalId ||
        runtime.pendingApprovalConfirmation ||
        runtime.sessionApprovalGrants.length > 0 ||
        runtime.approvalRules.length > 0 ? (
          <Suspense fallback={null}>
            <ApprovalPanel
              approvals={runtime.openApprovals}
              audit={runtime.approvalAudit}
              sessionGrants={runtime.sessionApprovalGrants}
              approvalRules={runtime.approvalRules}
              editingApprovalId={runtime.editingApprovalId}
              modificationDraft={runtime.approvalModificationDraft}
              pendingConfirmation={runtime.pendingApprovalConfirmation}
              confirmationText={runtime.approvalConfirmationText}
              onDecision={runtime.requestApprovalDecision}
              onStartModify={runtime.startApprovalModify}
              onUpdateModification={runtime.setApprovalModificationDraft}
              onSaveModify={runtime.saveApprovalModify}
              onCancelModify={runtime.clearApprovalInteraction}
              onUpdateConfirmation={runtime.setApprovalConfirmationText}
              onConfirmDecision={runtime.confirmApprovalDecision}
              onCancelConfirmation={runtime.clearApprovalInteraction}
            />
          </Suspense>
        ) : null}
        {runtime.knowledgeCitations.length > 0 ? (
          <CitationResults citations={runtime.knowledgeCitations} mode={runtime.knowledgeSearchMode} />
        ) : null}
        {runtime.importStatus ? (
          <DirectiveCards
            directives={runtime.contextualDirectives}
            connectors={connectors}
            onUseDirective={runtime.useDirective}
          />
        ) : null}
        {agent.state.usage ||
        visibleAgentError ||
        agent.state.running ||
        visibleRecoverableRuns.length > 0 ? (
          <section className="agent-panel" aria-label="Agent activity">
            {visibleRecoverableRuns.map((run) => (
              <div className="agent-panel__recovery" key={run.id}>
                <p>
                  {run.status === "interrupted" ? "Interrupted" : "Failed"} run · {run.model}
                  {run.transcript ? ` · ${run.transcript.slice(0, 120)}` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    activeAssistantMessageId.current = appendConversationMessage("assistant", "Working...");
                    void agent.retry(run);
                  }}
                >
                  Retry from prompt
                </button>
              </div>
            ))}
            {agent.state.usage ? (
              <p className="agent-panel__usage">
                {agent.state.usage.inputTokens} in · {agent.state.usage.outputTokens} out · {" "}
                {agent.state.usage.costUnknown
                  ? "cost unknown"
                  : `$${agent.state.usage.costUsd.toFixed(6)}${
                      agent.state.usage.costEstimated ? " estimated" : ""
                    }`}
              </p>
            ) : null}
            {agent.state.running ? (
              <p className="agent-panel__running">
                {agent.state.status === "awaiting-approval"
                  ? "Waiting for approval…"
                  : agent.state.status === "retrying"
                    ? "Retrying provider…"
                    : "Running…"}
                <button
                  type="button"
                  className="agent-panel__stop"
                  onClick={() => {
                    void agent.cancel();
                  }}
                >
                  Stop
                </button>
              </p>
            ) : null}
            {visibleAgentError ? (
              <p className="agent-panel__error">{visibleAgentError}</p>
            ) : null}
          </section>
        ) : null}
      </>
    );
  };

  const liveStatusLead = /[.!?]$/.test(runtime.lastAction)
    ? runtime.lastAction
    : `${runtime.lastAction}.`;
  // Label for the model chip: the selected model's friendly label, or a
  // placeholder when no model is selected/available on the connected backend.
  // Memoized so the composer's chip prop keeps a stable primitive unless the
  // model selection actually changes.
  const modelChipLabel = useMemo(
    () =>
      composerModels.find((model) => model.id === resolvedComposerModelOptionId)?.label ??
      "Select model",
    [composerModels, resolvedComposerModelOptionId]
  );

  // Settings nav search filter. Memoized (and kept above the onboarding early
  // return so the Rules of Hooks hold) so typing in the settings search box
  // does not refilter the static tab list on every unrelated render.
  const visibleSettingsTabs = useMemo(() => {
    const query = settingsModalSearch.trim().toLocaleLowerCase();
    if (!query) return settingsTabs;
    return settingsTabs.filter((tab) => tab.label.toLocaleLowerCase().includes(query));
  }, [settingsModalSearch]);

  /**
   * Submit raw composer text. Fable-owned slash commands (/goal, /plan,
   * /remember, /schedule) are parsed and executed first â€” they create
   * structured Fable state and, when a backend is connected, submit follow-up
   * model work through the agent run. Unknown slashes and ordinary text fall
   * through to the normal prompt path unchanged.
   */
  async function submitComposerText(rawText: string) {
    const submitted = rawText.trim();
    if (!submitted || agent.state.running || pendingPrompt) return;
    if (!selectedConversationThreadId) {
      setSubmissionInFlight(true);
      const thread = await durableConversation.createThread({
        authorityScope: { authority: "local", visibility: "member-private", ownerMemberId: "current-member" as never },
        title: submitted.slice(0, 72)
      });
      await durableConversation.deleteDraft();
      setSelectedConversationThreadId(thread.id);
      runtime.setActiveItem(thread.id);
      setConversationMessages([{ id: messageId("user"), role: "user", content: submitted }]);
      setPendingPrompt(submitted);
      return;
    }
    appendConversationMessage("user", submitted);
    void continueComposerSubmission(submitted);
  }

  async function continueComposerSubmission(submitted: string) {
    const outcome = parseComposerText(submitted);
    if (outcome.status === "command") {
      const result = await runtime.runFableCommand(outcome.request);
      // Clear the composer so the command token doesn't also reach the model
      // as ordinary prompt text. A follow-up prompt (if any) is submitted
      // through the same agent path as a normal prompt.
      runtime.setComposerValue("");
      appendConversationMessage("assistant", result.message);
      if (result.status === "ok" && result.followUpPrompt) {
        runPrompt(result.followUpPrompt, { appendUserMessage: false });
      }
      return;
    }
    runPrompt(submitted, { appendUserMessage: false });
  }

  function focusComposerAfterVoice() {
    window.requestAnimationFrame(() => runtime.composerRef.current?.focus());
  }

  function addDictationToComposer(transcript: string) {
    const composer = runtime.composerRef.current;
    const insertion = insertDictation(
      runtime.composerValue,
      transcript,
      composer?.selectionStart ?? runtime.composerValue.length,
      composer?.selectionEnd ?? runtime.composerValue.length
    );
    runtime.setComposerValue(insertion.value);
    window.requestAnimationFrame(() => {
      const currentComposer = runtime.composerRef.current;
      currentComposer?.focus();
      currentComposer?.setSelectionRange(insertion.caret, insertion.caret);
    });
  }

  function runPrompt(rawPrompt: string, options: { appendUserMessage?: boolean } = {}) {
    const prompt = rawPrompt.trim();
    if (!prompt) return;
    if (options.appendUserMessage !== false) {
      appendConversationMessage("user", prompt);
    }
    runtime.setComposerValue("");
    const nativeConnected = runtime.connectedAgentBackend;
    if (!nativeConnected) {
      runtime.submitPrompt(prompt);
      runtime.setComposerValue("");
      return;
    }
    const validation = validateModelSelection(
      nativeConnected.id,
      resolvedComposerModelId,
      runtime.selectableModels,
      2048
    );
    if (!validation.ok) {
      agent.reportError(validation.error ?? "The selected model cannot run.");
      appendConversationMessage("assistant", validation.error ?? "The selected model cannot run.");
      return;
    }
    const request = buildAgentRequest({
      model: resolvedComposerModelId,
      prompt,
      maxTokens: validation.maxTokens
    });
    activeAssistantMessageId.current = appendConversationMessage("assistant", "Working...");
    resetCancellation();
    void runtime.assembleKnowledgeContext(prompt).then((contextPrefix) =>
      agent.run(request, contextPrefix || undefined, runtime.permissionMode)
    );
  }

  // Subscribe the global shortcut listener once. The runtime object is not
  // referentially stable (it is rebuilt each render), so depending on it here
  // would tear down and re-add the keydown listener on every render. A ref
  // always points at the latest runtime, keeping the handlers current without
  // resubscribing.
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();
      const current = runtimeRef.current;
      if (key === "k") {
        event.preventDefault();
        current.setLastAction("Search ready");
        current.focusComposer("Search ");
      }

      if (key === "n") {
        event.preventDefault();
        current.startNewChat();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  // The account establishes the active workspace before provider setup.
  // Preview runtimes report a synthetic ready account, so they enter the
  // provider stage without a production-only bypass.
  const accountWorkspaceUsable = runtime.accountWorkspaceStatus.state === "ready" ||
    (runtime.accountWorkspaceStatus.state === "offline" && runtime.accountWorkspaceStatus.accountBound);
  const identityUsable = runtime.identityStatus.state === "signed-in" ||
    (runtime.identityStatus.state === "offline" && runtime.accountWorkspaceStatus.state === "offline" && runtime.accountWorkspaceStatus.accountBound);
  const accountReady = identityUsable && accountWorkspaceUsable;
  if (!accountReady || runtime.onboardingRequired) {
    return (
      <Suspense fallback={<div className="og-frame" aria-busy="true" />}>
        <OnboardingPage
          providers={runtime.backendProviders}
          connectedBackendIds={runtime.connectedBackendIds}
          status={runtime.backendStatus}
          identityStatus={runtime.identityStatus}
          identityPending={runtime.identityPending}
          accountWorkspaceStatus={runtime.accountWorkspaceStatus}
          accountWorkspacePending={runtime.accountWorkspacePending}
          onSignIn={runtime.signInIdentity}
          onRecover={runtime.recoverIdentity}
          onRefreshAccount={async () => {
            await runtime.refreshIdentity();
            await runtime.reconcileAccountWorkspace();
          }}
          onConnect={(providerId, secret) => void runtime.connectBackend(providerId, secret)}
          onConnectWithVerify={(providerId, secret) =>
            runtime.connectBackendWithVerify(providerId, secret)
          }
          onCheckConnection={async () => {
            await runtime.refreshBackendProviders();
          }}
          onComplete={runtime.dismissOnboarding}
        />
      </Suspense>
    );
  }

  const isSettingsActive = runtime.activePage === "Settings" || runtime.activePage === "Profile";

  const handleSelectSettingsTab = (tab: SettingsTab) => {
    setActiveSettingsTab(tab);
    runtime.setActiveItem("Settings");
  };

  const closeSettingsModal = () => {
    if (navigationIndex > 0) {
      navigateHistory(-1);
    } else {
      runtime.setActiveItem(previousActiveItem);
    }
  };

  const navigateHistory = (offset: -1 | 1) => {
    const nextIndex = navigationIndex + offset;
    const target = navigationHistory.current[nextIndex];
    if (!target || nextIndex < 0 || nextIndex >= navigationHistory.current.length) {
      return;
    }
    navigationTarget.current = target;
    setNavigationIndex(nextIndex);
    runtime.setActiveItem(target);
  };

  return (
    <main
      className={`desktop-frame${sidebarCollapsed ? " desktop-frame--sidebar-collapsed" : ""}`}
      data-theme={theme}
    >
      <WorkspaceSidebar
        workspaceName={workspaceName}
        utilityItems={utilityItems}
        activeItem={runtime.activeItem}
        profile={verifiedProfile}
        expandedCollections={expandedCollections}
        expandedProjects={expandedProjects}
        projects={projects}
        chatThreads={durableThreads}
        mobileNavOpen={runtime.mobileNavOpen}
        collapsed={sidebarCollapsed}
        loadingItemIds={loadingItemIds}
        isSettingsActive={false}
        activeSettingsTab={activeSettingsTab}
        onSelectSettingsTab={handleSelectSettingsTab}
        canNavigateBack={navigationIndex > 0}
        canNavigateForward={navigationIndex < navigationHistory.current.length - 1}
        onNavigateBack={() => navigateHistory(-1)}
        onNavigateForward={() => navigateHistory(1)}
        onCloseSettings={closeSettingsModal}
        onNewChat={() => {
          setSelectedConversationThreadId(undefined);
          activeAssistantMessageId.current = null;
          setConversationMessages([]);
          runtime.startNewChat();
        }}
        onAddProject={() => {
          runtime.setActiveItem("new-thread");
          runtime.setLastAction("New project from scratch ready");
          runtime.focusComposer("Start a new project from scratch: ");
        }}
        onOpenProjectFolder={() => {
          runtime.setActiveItem("new-thread");
          runtime.setLastAction("Choose a project folder");
          projectFolderInputRef.current?.click();
        }}
        onSearch={() => {
          runtime.setLastAction("Search ready");
          runtime.focusComposer("Search ");
        }}
        onSelectWorkspace={() => runtime.setLastAction("Workspace selector ready")}
        accountWorkspaces={runtime.accountWorkspaceStatus.workspaces}
        activeAccountWorkspaceId={runtime.accountWorkspaceStatus.activeWorkspace.fableWorkspaceId}
        workspacePending={runtime.accountWorkspacePending}
        onSelectAccountWorkspace={async (fableWorkspaceId) => {
          await runtime.selectAccountWorkspace(fableWorkspaceId);
          runtime.setLastAction("Workspace switched");
        }}
        onCreateAccountWorkspace={async (name) => {
          await runtime.createAccountWorkspace(name);
          runtime.setLastAction("Workspace created");
        }}
        onToggleProjects={() =>
          setExpandedCollections((current) => ({ ...current, projects: !current.projects }))
        }
        onToggleChats={() =>
          setExpandedCollections((current) => ({ ...current, chats: !current.chats }))
        }
        onSelectUtility={(label) => {
          runtime.setActiveItem(label);
          runtime.setLastAction(`${label} selected`);
        }}
        onSelectProjectThread={(thread, projectTitle) => runtime.openThread(thread, projectTitle)}
        onToggleProject={(projectId, projectTitle, expanded) => {
          setExpandedProjects((current) => ({ ...current, [projectId]: !expanded }));
          runtime.setLastAction(`${expanded ? "Collapsed" : "Expanded"} project: ${projectTitle}`);
        }}
        onToggleMobileNav={() => runtime.setMobileNavOpen((open) => !open)}
        onToggleCollapsed={() => {
          setSidebarCollapsed((collapsed) => !collapsed);
          runtime.setLastAction(sidebarCollapsed ? "Navigation opened" : "Navigation closed");
        }}
        onOpenMobileConnection={() => {
          setActiveSettingsTab("privacy");
          runtime.setActiveItem("Settings");
          runtime.setMobileNavOpen(false);
          runtime.setLastAction("Mobile approvals opened");
        }}
        onOpenWorkspaceSettings={() => {
          setWorkspaceSettingsStatus("");
          setWorkspaceSettingsOpen(true);
          runtime.setMobileNavOpen(false);
          runtime.setLastAction("Workspace settings opened");
        }}
        onSelectThread={(thread) => {
          setSelectedConversationThreadId(thread.id);
          activeAssistantMessageId.current = null;
          setConversationMessages([]);
          runtime.openThread(thread, "chat");
        }}
        onAccountMenu={(item) => {
          if (item === "logout") {
            void runtime.signOutIdentity();
            runtime.setLastAction("Signing out of Fable account");
            return;
          }

          const page = item === "profile" ? "Profile" : "Settings";
          runtime.setActiveItem(page);
          runtime.setMobileNavOpen(false);
          runtime.setLastAction(`${page} selected`);
        }}
      />
      <input
        ref={(node) => {
          projectFolderInputRef.current = node;
          node?.setAttribute("webkitdirectory", "");
          node?.setAttribute("directory", "");
        }}
        className="sr-only"
        type="file"
        multiple
        aria-label="Open project folder"
        onChange={(event) => {
          const firstFile = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          const folderName =
            firstFile?.webkitRelativePath.split("/")[0] ||
            firstFile?.name ||
            "selected folder";
          const prompt = `Open the ${folderName} folder as a project: `;
          runtime.focusComposer(prompt);
          runtime.setLastAction(`Project folder selected: ${folderName}`);
        }}
      />

      <section className="workspace" aria-label="Fable workspace">
        {runtime.activePage && !isSettingsActive ? (
          <ShellPageBoundary runtime={runtime} />
        ) : (
          <div className="workspace-center workspace-center--composer">
            {renderConversation()}
            <Composer
              composerRef={runtime.composerRef}
              fileInputRef={runtime.fileInputRef}
              composerValue={runtime.composerValue}
              onComposerChange={runtime.setComposerValue}
              onSubmit={(event) => {
                event.preventDefault();
                const text = runtime.composerValue;
                if (!text.trim() || agent.state.running || pendingPrompt) return;
                void submitComposerText(text);
              }}
              voiceStatus={voice.state.status}
              voiceMessage={voice.state.message}
              voiceCanStart={voice.canStart}
              voiceDisclosure={voice.processingDisclosure}
              onStartVoice={() => void voice.start()}
              onStopVoice={voice.stop}
              onCancelVoice={voice.cancel}
              onDismissVoice={voice.dismiss}
              onAttach={runtime.triggerAttach}
              addMenuOpen={addMenuOpen}
              permissionsOpen={toolPickerOpen}
              onTogglePermissions={() => {
                setToolPickerOpen((open) => !open);
                setAddMenuOpen(false);
                runtime.setLastAction("Tool picker toggled");
              }}
              onToggleAddMenu={() => {
                setAddMenuOpen((open) => !open);
                setToolPickerOpen(false);
                runtime.setLastAction("Add menu toggled");
              }}
              onOpenTool={(tool) => {
                setAddMenuOpen(false);
                runtime.setActiveItem(tool);
                runtime.setLastAction(`${tool} selected`);
              }}
              onRunCommand={runtime.runCommand}
              onFileChange={runtime.handleComposerAttachmentChange}

              importStatus={runtime.importStatus}
              models={composerModels}
              selectedModelId={resolvedComposerModelOptionId}
              selectedModelLabel={modelChipLabel}
              onSelectModel={runtime.selectModel}
              permissionLabel={runtime.permissionLabel}
              permissionProfiles={PERMISSION_PROFILES}
              onSelectPermissionLabel={runtime.selectPermissionLabel}
              inThread={!!selectedConversationThreadId}
              connectedConnectors={connectedConnectorCards}
              knowledgeSources={runtime.workspaceKnowledgeSources}
              attachments={runtime.composerAttachments}
              onRemoveAttachment={runtime.removeComposerAttachment}
            />

            {renderChatContext()}
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {liveStatusLead} {runtime.managedMemoryRecords.length} memory items.{" "}
          {runtime.workspaceKnowledgeSources.length} sources. {runtime.openApprovals.length} approvals
          pending. {scheduledActive ? `Running scheduled prompt ${scheduledActive.jobId}.` : ""}
        </p>
      </section>

      {isSettingsActive ? (
        <div className="settings-modal-backdrop" role="presentation">
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
            <aside className="settings-modal__nav" aria-label="Settings sections">
              <label className="settings-modal__search">
                <MagnifyingGlass size={15} aria-hidden="true" />
                <span className="sr-only">Search settings</span>
                <input
                  type="search"
                  placeholder="Search settings"
                  value={settingsModalSearch}
                  onChange={(event) => setSettingsModalSearch(event.target.value)}
                />
              </label>
              <nav className="settings-modal__tab-list" aria-label="Settings">
                {visibleSettingsTabs.map((tab) => {
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={activeSettingsTab === tab.id ? "settings-modal__tab settings-modal__tab--active" : "settings-modal__tab"}
                      aria-current={activeSettingsTab === tab.id ? "page" : undefined}
                      onClick={() => handleSelectSettingsTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
            </aside>
            <div className="settings-modal__content">
              <button
                type="button"
                className="settings-modal__close"
                aria-label="Close settings"
                onClick={closeSettingsModal}
              >
                <X size={17} />
              </button>
              <Suspense fallback={null}>
                <SettingsPage
                  runtime={runtime}
                  theme={theme}
                  onThemeChange={setTheme}
                  activeTab={activeSettingsTab}
                  workspaceName={workspaceName}
                  dictationCapability={voice.capability}
                  titleId="settings-modal-title"
                />
              </Suspense>
            </div>
          </section>
        </div>
      ) : null}

      {workspaceSettingsOpen ? (
        <div className="settings-modal-backdrop" role="presentation">
          <section
            className="settings-modal settings-modal--workspace"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-settings-modal-title"
          >
            <div className="settings-modal__content">
              <button
                type="button"
                className="settings-modal__close"
                aria-label="Close workspace settings"
                onClick={() => {
                  setWorkspaceSettingsOpen(false);
                  setWorkspaceSettingsStatus("");
                }}
              >
                <X size={17} />
              </button>
              <section className="settings-page" aria-labelledby="workspace-settings-modal-title">
                <div className="settings-page__content">
                  <div className="settings-page__header">
                    <h1 id="workspace-settings-modal-title">{workspaceName}</h1>
                  </div>
                  <Suspense fallback={null}>
                    <WorkspaceSettingsView
                      workspaceName={workspaceName}
                      onStatus={(message) => {
                        setWorkspaceSettingsStatus(message);
                        runtime.setLastAction(message);
                      }}
                    />
                  </Suspense>
                  {workspaceSettingsStatus ? (
                    <p className="settings-status" role="status">
                      {workspaceSettingsStatus}
                    </p>
                  ) : null}
                </div>
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
