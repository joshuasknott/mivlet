import "../styles/composer-plugins.css";
import { ChangeEvent, FormEvent, RefObject, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { UploadSimple } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { ComposerPluginsMenu } from "./ComposerPluginsMenu";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Stop } from "@phosphor-icons/react/dist/csr/Stop";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ACCEPTED_COMPOSER_ATTACHMENTS } from "../lib/constants";
import type { ProviderModelOption } from "../lib/provider-models";
import type { VoiceStatus } from "../hooks/useVoice";
import type { ComposerAttachment } from "../lib/types";
import { ConnectorIcon } from "./ConnectorIcon";
import { ModelPicker } from "./ModelPicker";
import { RecordingReview } from "./RecordingReview";
import type { SpeechRecordingReview } from "@mivlet/connectors/voice";
import { AgentAvatar } from "./agents/agent-icons";
import {
  workspaceMentionToken,
  type WorkspaceMentionAgent,
} from "../lib/collaboration-mentions";

export function Composer({
  composerRef,
  fileInputRef,
  composerValue,
  onComposerChange,
  onSubmit,
  voiceStatus,
  voiceMessage,
  voiceCanStart,
  voiceDisclosure,
  voiceReview,
  onAuthorizeVoice,
  onStartVoice,
  onStopVoice,
  onCancelVoice,
  onDismissVoice,
  onAttach,
  addMenuOpen,
  onToggleAddMenu,
  onOpenTool,
  onFileChange,
  importStatus,
  models,
  selectedModelId,
  selectedModelLabel,
  modelScope,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  placeholder = "Ask anything…",
  onSelectModel,
  inThread = false,
  isWorking = false,
  allowQueue = false,
  onStop,
  connectedConnectors = [],
  attachments = [],
  onRemoveAttachment,
  recipientControl,
  modelControl,
  secondaryControlsInMenu = false,
  onConnectProvider,
  onSaveConclusion,
  compactAgentSurface = false,
  agentMentions = [],
}: {
  composerRef: RefObject<ComposerInputHandle | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  voiceStatus: VoiceStatus;
  voiceMessage: string;
  voiceCanStart: boolean;
  voiceDisclosure: string;
  voiceReview?: SpeechRecordingReview | null;
  onAuthorizeVoice?: () => void;
  onStartVoice: () => void;
  onStopVoice: () => void;
  onCancelVoice: () => void;
  onDismissVoice: () => void;
  onAttach: () => void;
  addMenuOpen: boolean;
  onToggleAddMenu: () => void;
  onOpenTool: (tool: "Plugins") => void;
  onRunCommand: (command: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  importStatus?: string | null;
  /** Provider-aware choices across every connected runnable backend. */
  models: ProviderModelOption[];
  /** Currently selected model id, or "" when none is selected/available. */
  selectedModelId: string;
  /** Label to show on the model chip when a model is selected. */
  selectedModelLabel: string;
  modelScope?: string;
  selectedReasoningEffort?: string;
  onSelectReasoningEffort?: (effort: string | undefined) => void;
  placeholder?: string;
  onSelectModel: (modelId: string) => void;
  inThread?: boolean;
  isWorking?: boolean;
  /** Keep steering available while another assignment owns the response. */
  allowQueue?: boolean;
  onStop?: () => void;
  connectedConnectors?: { id: string; name: string; status: string }[];
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (attachmentId: string) => void;
  recipientControl?: ReactNode;
  modelControl?: ReactNode;
  secondaryControlsInMenu?: boolean;
  onConnectProvider?: () => void;
  onSaveConclusion?: () => void;
  compactAgentSurface?: boolean;
  /** Existing workspace agents available to the @ picker. */
  agentMentions?: readonly WorkspaceMentionAgent[];
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [caretOffset, setCaretOffset] = useState(() => composerValue.length);
  const voiceId = useId();
  const mentionPickerId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const closeExternalMenus = () => { if (addMenuOpen) onToggleAddMenu(); };
  useEffect(() => {
    if (!addMenuOpen) return;
    formRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!formRef.current?.contains(event.target as Node)) closeExternalMenus();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [addMenuOpen]);

  const isNewThread = !inThread;
  const menuPlacementClass = isNewThread ? "composer-glow--new-thread" : "composer-glow--in-thread";
  const voiceListening = voiceStatus === "listening";
  const voiceTransitioning =
    voiceStatus === "starting" ||
    voiceStatus === "stopping" ||
    voiceStatus === "reviewing" ||
    voiceStatus === "processing";
  const voiceCancelable =
    voiceStatus === "starting" ||
    voiceStatus === "listening" ||
    voiceStatus === "stopping" || voiceStatus === "reviewing" || voiceStatus === "processing";
  const voiceUnavailable =
    voiceStatus === "disabled" || voiceStatus === "unsupported";
  const voiceTerminal =
    voiceStatus === "cancelled" ||
    voiceStatus === "error" ||
    voiceStatus === "permission-denied" ||
    voiceStatus === "success" ||
    voiceStatus === "unavailable";
  const voiceActionLabel = voiceListening
    ? "Stop dictation"
    : voiceTransitioning
      ? voiceStatus === "starting"
        ? "Starting dictation"
        : "Processing dictation"
      : voiceCanStart
        ? voiceTerminal
          ? "Try dictation again"
          : "Start dictation"
        : voiceMessage;
  const showVoiceFeedback =
    voiceStatus !== "idle" && voiceStatus !== "disabled" && voiceStatus !== "unsupported";
  const hasComposerText = composerValue.trim().length > 0;
  const hasComposerAttachments = attachments.length > 0;
  const hasMeaningfulContent = hasComposerText || hasComposerAttachments;
  const dictationBusy = voiceListening || voiceTransitioning;
  const showStop = isWorking && (!allowQueue || !hasMeaningfulContent);
  const currentToken = useMemo(() => {
    const end = Math.max(0, Math.min(caretOffset, composerValue.length));
    const beforeCaret = composerValue.slice(0, end);
    const match = beforeCaret.match(/(^|\s)([\/@][^\s]*)$/);
    if (!match) return null;
    return {
      token: match[2],
      start: end - match[2].length,
      end,
    };
  }, [caretOffset, composerValue]);
  const agentSuggestions = useMemo(() => {
    if (!currentToken || !currentToken.token.startsWith("@")) return [];
    const query = currentToken.token.slice(1).toLocaleLowerCase();
    return agentMentions
      .filter((agent) => {
        const name = agent.name.toLocaleLowerCase();
        const id = agent.id.toLocaleLowerCase();
        return !query || name.startsWith(query) || id.startsWith(query);
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }, [agentMentions, currentToken]);
  const connectorSuggestions = useMemo(() => {
    if (!currentToken) return [];
    const query = currentToken.token.toLowerCase();
    if (query.startsWith("@")) {
      return connectedConnectors
        .map((connector) => {
          const mention = `@${connector.id}`;
          return {
            id: connector.id,
            label: mention,
            description: connector.name,
            value: mention
          };
        })
        .filter((connector) => connector.label.toLowerCase().startsWith(query));
    }
    return [];
  }, [connectedConnectors, currentToken]);
  const mentionPickerOpen = agentSuggestions.length > 0 && !mentionDismissed;
  useEffect(() => {
    setMentionIndex(0);
    setMentionDismissed(false);
  }, [currentToken?.token, agentSuggestions.length]);
  useEffect(() => {
    if (!mentionPickerOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!formRef.current?.contains(event.target as Node)) setMentionDismissed(true);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [mentionPickerOpen]);
  const applyAgentMention = (agent: WorkspaceMentionAgent) => {
    if (!currentToken) return;
    setMentionDismissed(true);
    const value = workspaceMentionToken(agent);
    const suffix = composerValue.slice(currentToken.end);
    const separator = suffix.startsWith(" ") || suffix.startsWith("\n") ? "" : " ";
    const nextCursor = currentToken.start + value.length + separator.length;
    const next = `${composerValue.slice(0, currentToken.start)}${value}${separator}${suffix}`;
    setCaretOffset(nextCursor);
    onComposerChange(next);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const applyComposerSuggestion = (value: string) => {
    if (!currentToken) return;
    const suffix = composerValue.slice(currentToken.end);
    const separator = suffix.startsWith(" ") || suffix.startsWith("\n") ? "" : " ";
    const nextCursor = currentToken.start + value.length + separator.length;
    const next = `${composerValue.slice(0, currentToken.start)}${value}${separator}${suffix}`;
    setCaretOffset(nextCursor);
    onComposerChange(next);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <>
      {attachments.length > 0 ? (
        <div className={`composer-attachments ${isNewThread ? "composer-attachments--new-thread" : "composer-attachments--in-thread"}`}>
          {attachments.map((attachment) => (
            <div className="composer-attachment" key={attachment.id}>
              {attachment.previewUrl ? (
                <a
                  className="composer-attachment__preview"
                  href={attachment.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${attachment.name} preview`}
                >
                  <img src={attachment.previewUrl} alt="" />
                </a>
              ) : (
                <span className="composer-attachment__icon" aria-hidden="true">
                  <FileText size={14} />
                </span>
              )}
              <span className="composer-attachment__body">
                <strong title={attachment.name}>{attachment.name}</strong>
                {attachment.status ? <small>{attachment.status}</small> : null}
              </span>
              {onRemoveAttachment ? (
                <button
                  type="button"
                  className="composer-attachment__remove"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X size={12} weight="bold" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <form
        ref={formRef}
        className={`composer-glow ${menuPlacementClass}${compactAgentSurface ? " composer-glow--compact-agent" : ""}`}
        onSubmit={(event) => {
          if (voiceListening || voiceTransitioning) { event.preventDefault(); return; }
          onSubmit(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && voiceCancelable) {
            event.preventDefault();
            onCancelVoice();
          } else if (event.key === "Escape" && addMenuOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeExternalMenus(); addTrigger.current?.focus();
          } else if (event.key === "Escape" && mentionPickerOpen) {
            event.preventDefault();
            event.stopPropagation();
            setMentionDismissed(true);
          }
        }}
      >
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept={ACCEPTED_COMPOSER_ATTACHMENTS}
          multiple
          aria-label="Attach files"
          onChange={onFileChange}
        />
        <div className="composer">
        <div className="composer-field">
          <ComposerInput
            inputRef={composerRef}
            value={composerValue}
            onChange={onComposerChange}
            connectors={connectedConnectors}
            agentMentions={agentMentions}
            mentionPickerOpen={mentionPickerOpen}
            mentionPickerId={mentionPickerId}
            mentionActiveId={mentionPickerOpen && agentSuggestions[mentionIndex] ? `${mentionPickerId}-${agentSuggestions[mentionIndex].id}` : undefined}
            onMentionPickerDismiss={() => setMentionDismissed(true)}
            onSelectionChange={(start) => setCaretOffset(start)}
            onKeyDown={(event) => {
              if (mentionPickerOpen) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  event.stopPropagation();
                  setMentionIndex((current) => event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, agentSuggestions.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + agentSuggestions.length) % agentSuggestions.length);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)) {
                  event.preventDefault();
                  event.stopPropagation();
                  const agent = agentSuggestions[mentionIndex] ?? agentSuggestions[0];
                  if (agent) applyAgentMention(agent);
                  return;
                }
              }
              if (
                connectorSuggestions.length > 0 &&
                (event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing))
              ) {
                event.preventDefault();
                applyComposerSuggestion(connectorSuggestions[0].value);
                return;
              }
              // Enter sends; Shift+Enter (and IME composition) insert a newline.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!dictationBusy && hasMeaningfulContent && (!isWorking || allowQueue)) {
                  onSubmit(event as unknown as FormEvent);
                }
              }
            }}
            placeholder={placeholder}
          />
          {mentionPickerOpen ? (
            <div id={mentionPickerId} className="composer-suggestions agent-mention-picker" role="listbox" aria-label="Workspace agents">
              {agentSuggestions.map((agent, index) => (
                <button
                  key={agent.id}
                  id={`${mentionPickerId}-${agent.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyAgentMention(agent)}
                >
                  <AgentAvatar
                    seed={agent.avatarSeed ?? `blob-v1:${agent.id}`}
                    color={agent.iconColor}
                    imageDataUrl={agent.iconImageDataUrl}
                    iconSize={24}
                  />
                  <span className="agent-mention-picker__identity">
                    <strong>{agent.name}</strong>
                    <small>@{agent.id}{agentSuggestions.filter((candidate) => candidate.name === agent.name).length > 1 ? " · duplicate name" : ""}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : connectorSuggestions.length > 0 ? (
            <div className="composer-suggestions" role="listbox" aria-label="Composer suggestions">
              {connectorSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  role="option"
                  onClick={() => applyComposerSuggestion(suggestion.value)}
                >
                  <span className="connector-mention"><span aria-hidden="true"><ConnectorIcon id={suggestion.id} /></span>{suggestion.description}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="composer-controls">
          <div className="composer-control-group">
            <div className="composer-control-anchor composer-control-anchor--add">
              <button
                ref={addTrigger}
                type="button"
                className={`composer-chip composer-chip--attach${addMenuOpen ? " composer-chip--active composer-trigger--open" : ""}`}
                onClick={() => {
                  setModelOpen(false);
                  onToggleAddMenu();
                }}
                aria-expanded={addMenuOpen}
                aria-label="Add files and context"
              >
                <Plus size={20} />
              </button>
              {addMenuOpen ? (
                <div className="composer-menu composer-add-menu" role="menu" aria-label="Add to prompt" onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button[role="menuitem"], :scope > .composer-plugins > button')];
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }}>
                  <button type="button" role="menuitem" onClick={() => { onAttach(); closeExternalMenus(); }}>
                    <UploadSimple size={18} /><span>Upload files</span>
                  </button>
                  {secondaryControlsInMenu ? <>
                    <button type="button" role="menuitem" onClick={() => { closeExternalMenus(); setModelOpen(true); }}>Model and reasoning…</button>
                    {onSaveConclusion ? <button type="button" role="menuitem" onClick={() => { closeExternalMenus(); onSaveConclusion(); }}>Save conclusion to Memory…</button> : null}
                  </> : null}
                  {!secondaryControlsInMenu && onSaveConclusion ? <button type="button" role="menuitem" onClick={() => { closeExternalMenus(); onSaveConclusion(); }}>Save conclusion to Memory…</button> : null}
                  <ComposerPluginsMenu connectors={connectedConnectors} onMention={(id) => {
                    const prompt = composerValue + (composerValue && !/\s$/.test(composerValue) ? " " : "") + "@" + id + " ";
                    onComposerChange(prompt); closeExternalMenus(); composerRef.current?.focus();
                  }} onAdd={() => { closeExternalMenus(); onOpenTool("Plugins"); }} />
                </div>
              ) : null}
            </div>


            {recipientControl}
            {secondaryControlsInMenu ? <div className="composer-secondary-model">
              <ModelPicker hideTrigger models={models} selectedId={selectedModelId} label={selectedModelLabel}
                scopeLabel={modelScope} effort={selectedReasoningEffort} onSelect={onSelectModel}
                onSelectEffort={onSelectReasoningEffort} open={modelOpen}
                onOpenChange={(open) => { setModelOpen(open); if (!open) addTrigger.current?.focus(); }} />
            </div> : null}
          </div>

          <div className="composer-control-group composer-control-group--end">
            {!compactAgentSurface && !secondaryControlsInMenu && (modelControl ?? (!models.some(model => model.available) && onConnectProvider
              ? <button type="button" className="composer-model" onClick={() => { closeExternalMenus(); onConnectProvider(); }}>Connect a provider</button>
              : <ModelPicker models={models} selectedId={selectedModelId}
              label={selectedModelLabel} scopeLabel={modelScope} effort={selectedReasoningEffort} onSelect={onSelectModel}
              onSelectEffort={onSelectReasoningEffort} open={modelOpen}
              onOpenChange={(open) => { if (open) closeExternalMenus(); setModelOpen(open); }} />))}
            {secondaryControlsInMenu && !models.some(model => model.id === selectedModelId && model.available) ? <button type="button" className="composer-model" onClick={() => {
              closeExternalMenus();
              if (models.some(model => model.available)) setModelOpen(true);
              else onConnectProvider?.();
            }}>{models.some(model => model.available) ? "Choose model" : "Connect a provider"}</button> : null}

            {!isWorking ? (
              <div className="voice-actions" data-state={voiceStatus}>
                <div className="voice-action">
                  <button
                    type="button"
                    className="composer-chip voice-action__primary"
                    onClick={() => {
                      if (voiceListening) onStopVoice();
                      else if (voiceCanStart && !voiceTransitioning) onStartVoice();
                    }}
                    aria-label={voiceActionLabel}
                    aria-pressed={voiceListening}
                    aria-busy={voiceTransitioning}
                    aria-disabled={voiceUnavailable || voiceTransitioning}
                    aria-describedby={`${voiceId}-status ${voiceId}-disclosure`}
                  >
                    {voiceListening ? (
                      <Stop size={15} weight="fill" />
                    ) : (
                      <Microphone size={19} />
                    )}
                  </button>
                  <span className="voice-tooltip" role="tooltip" aria-hidden="true">
                    {voiceActionLabel}
                  </span>
                </div>
                <button
                  type="button"
                  className="composer-chip voice-action__cancel"
                  onClick={onCancelVoice}
                  aria-label="Cancel dictation"
                  aria-hidden={!voiceCancelable}
                  tabIndex={voiceCancelable ? 0 : -1}
                >
                  <X size={16} weight="bold" />
                </button>
              </div>
            ) : null}
            {!dictationBusy && isWorking ? <button
              className={`send-button${showStop ? " send-button--stop" : ""}`}
              type={showStop ? "button" : "submit"}
              aria-label={showStop ? "Stop response" : "Send prompt"}
              onClick={showStop ? onStop : undefined}
            >
              {showStop ? (
                <Stop size={14} weight="fill" />
              ) : (
                <ArrowUp size={20} />
              )}
            </button> : null}
            {!dictationBusy && !isWorking ? <button
              className="send-button"
              type="submit"
              disabled={!hasMeaningfulContent}
              aria-label="Send prompt"
            >
              <ArrowUp size={20} />
            </button> : null}

          </div>
        </div>

        {voiceReview && onAuthorizeVoice ? <RecordingReview review={voiceReview} onConfirm={onAuthorizeVoice} onCancel={onCancelVoice} /> : null}
        {showVoiceFeedback ? (
          <div
            className="voice-feedback"
            data-state={voiceStatus}
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="voice-feedback__indicator" aria-hidden="true" />
            <span id={`${voiceId}-status`}>{voiceMessage}</span>
            {voiceTerminal ? (
              <button type="button" onClick={onDismissVoice}>
                Dismiss
              </button>
            ) : null}
          </div>
        ) : (
          <span id={`${voiceId}-status`} className="sr-only">
            {voiceMessage}
          </span>
        )}
        <span id={`${voiceId}-disclosure`} className="sr-only">
          {voiceDisclosure}
        </span>
        {importStatus ? <div className="composer-status" role="status">{importStatus}</div> : null}
      </div>
      </form>
    </>
  );
}
