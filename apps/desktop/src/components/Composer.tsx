import { ChangeEvent, FormEvent, KeyboardEvent, RefObject, useEffect, useMemo, useState } from "react";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { Books } from "@phosphor-icons/react/dist/csr/Books";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { FileArrowUp } from "@phosphor-icons/react/dist/csr/FileArrowUp";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { HandPalm } from "@phosphor-icons/react/dist/csr/HandPalm";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { Paperclip } from "@phosphor-icons/react/dist/csr/Paperclip";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import { Stop } from "@phosphor-icons/react/dist/csr/Stop";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ACCEPTED_COMPOSER_ATTACHMENTS } from "../lib/constants";
import type { PermissionProfile } from "../lib/agent-run";
import type { ProviderModelOption } from "../lib/provider-models";
import type { VoiceStatus } from "../hooks/useVoice";
import type { ComposerAttachment } from "../lib/types";
import { ConnectorIcon } from "./ConnectorIcon";
import { ModelPicker } from "./ModelPicker";

const PERMISSION_PRESENTATION = {
  "Read Only": {
    label: "Read only",
    icon: HandPalm
  },
  "Ask Me": {
    label: "Ask first",
    icon: ShieldCheck
  },
  "Work Freely": {
    label: "Full access",
    icon: ShieldWarning
  },
  Custom: {
    label: "Custom",
    icon: GearSix
  }
} as const;

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
  onStartVoice,
  onStopVoice,
  onCancelVoice,
  onDismissVoice,
  onAttach,
  addMenuOpen,
  permissionsOpen,
  onToggleAddMenu,
  onTogglePermissions,
  onOpenTool,
  onFileChange,
  importStatus,
  models,
  selectedModelId,
  selectedModelLabel,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  placeholder = "Ask anything…",
  onSelectModel,
  permissionLabel,
  permissionProfiles,
  onSelectPermissionLabel,
  inThread = false,
  isWorking = false,
  onStop,
  connectedConnectors = [],
  knowledgeSources = [],
  attachments = [],
  onRemoveAttachment,
  compactAgentSurface = false
}: {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  voiceStatus: VoiceStatus;
  voiceMessage: string;
  voiceCanStart: boolean;
  voiceDisclosure: string;
  onStartVoice: () => void;
  onStopVoice: () => void;
  onCancelVoice: () => void;
  onDismissVoice: () => void;
  onAttach: () => void;
  addMenuOpen: boolean;
  permissionsOpen: boolean;
  onToggleAddMenu: () => void;
  onTogglePermissions: () => void;
  onOpenTool: (tool: "Connectors" | "Knowledge") => void;
  onRunCommand: (command: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  importStatus?: string | null;
  /** Provider-aware choices across every connected runnable backend. */
  models: ProviderModelOption[];
  /** Currently selected model id, or "" when none is selected/available. */
  selectedModelId: string;
  /** Label to show on the model chip when a model is selected. */
  selectedModelLabel: string;
  selectedReasoningEffort?: string;
  onSelectReasoningEffort?: (effort: string | undefined) => void;
  placeholder?: string;
  onSelectModel: (modelId: string) => void;
  /** Label of the active approval preset (drives the chip text). */
  permissionLabel: string;
  /** Approval presets available in the picker. */
  permissionProfiles: readonly PermissionProfile[];
  onSelectPermissionLabel: (label: string) => void;
  inThread?: boolean;
  isWorking?: boolean;
  onStop?: () => void;
  connectedConnectors?: { id: string; name: string; status: string }[];
  knowledgeSources?: { id: string; title: string; provenance: string; connectorId?: string }[];
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (attachmentId: string) => void;
  compactAgentSurface?: boolean;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<"connectors" | "knowledge" | null>(null);
  const activePermissionPresentation =
    PERMISSION_PRESENTATION[permissionLabel as keyof typeof PERMISSION_PRESENTATION];
  const visiblePermissionLabel = activePermissionPresentation?.label ?? permissionLabel;

  const closeExternalMenus = () => {
    if (addMenuOpen) onToggleAddMenu();
    if (permissionsOpen) onTogglePermissions();
    setActiveSubmenu(null);
  };
  const openSubmenu = (submenu: "connectors" | "knowledge") => {
    if (submenu === "connectors" && connectedConnectors.length === 0) return;
    if (submenu === "knowledge" && knowledgeSources.length === 0) return;
    setActiveSubmenu(submenu);
  };

  const isNewThread = !inThread;
  const menuPlacementClass = isNewThread ? "composer-glow--new-thread" : "composer-glow--in-thread";
  const voiceListening = voiceStatus === "listening";
  const voiceTransitioning =
    voiceStatus === "starting" ||
    voiceStatus === "stopping" ||
    voiceStatus === "processing";
  const voiceCancelable =
    voiceStatus === "starting" ||
    voiceStatus === "listening" ||
    voiceStatus === "stopping";
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
  useEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 248)}px`;
  }, [composerRef, composerValue, inThread]);
  const currentToken = useMemo(() => {
    const match = composerValue.match(/(^|\s)([\/@][^\s]*)$/);
    if (!match) return null;
    return {
      token: match[2],
      start: composerValue.length - match[2].length
    };
  }, [composerValue]);
  const composerSuggestions = useMemo(() => {
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
  const applyComposerSuggestion = (value: string) => {
    if (!currentToken) return;
    const next = `${composerValue.slice(0, currentToken.start)}${value} `;
    onComposerChange(next);
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(next.length, next.length);
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
                  <FileArrowUp size={14} />
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
        className={`composer-glow ${menuPlacementClass}${compactAgentSurface ? " composer-glow--compact-agent" : ""}`}
        onSubmit={onSubmit}
        onKeyDown={(event) => {
          if (event.key === "Escape" && voiceCancelable) {
            event.preventDefault();
            onCancelVoice();
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
          <textarea
            ref={composerRef}
            className="composer-input"
            value={composerValue}
            onChange={(event) => onComposerChange(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (
                composerSuggestions.length > 0 &&
                (event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing))
              ) {
                event.preventDefault();
                applyComposerSuggestion(composerSuggestions[0].value);
                return;
              }
              // Enter sends; Shift+Enter (and IME composition) insert a newline.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSubmit(event as unknown as FormEvent);
              }
            }}
            placeholder={placeholder}
            aria-label="Universal composer"
            rows={1}
          />
          {composerSuggestions.length > 0 ? (
            <div className="composer-suggestions" role="listbox" aria-label="Composer suggestions">
              {composerSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  role="option"
                  onClick={() => applyComposerSuggestion(suggestion.value)}
                >
                  <strong>{suggestion.label}</strong>
                  <small>{suggestion.description}</small>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="composer-controls">
          <div className="composer-control-group">
            <div className="composer-control-anchor">
              <button
                type="button"
                className={`composer-chip composer-chip--attach${addMenuOpen ? " composer-chip--active composer-trigger--open" : ""}`}
                onClick={() => {
                  setModelOpen(false);
                  onToggleAddMenu();
                  setActiveSubmenu(null);
                }}
                aria-expanded={addMenuOpen}
                aria-label="Add files and context"
              >
                <Paperclip size={20} />
              </button>
              {addMenuOpen ? (
                <div className="composer-menu composer-add-menu" role="menu" aria-label="Add to prompt">
                  <span className="composer-menu__heading">Add to prompt</span>

                  <button type="button" role="menuitem" onClick={onAttach}>
                    <FileArrowUp size={18} />
                    <span><strong>Files</strong><small>Upload documents or attachments</small></span>
                  </button>

                  <div
                    className={`composer-menu-item-wrapper${activeSubmenu === "connectors" ? " is-active" : ""}`}
                    onPointerEnter={() => openSubmenu("connectors")}
                    onMouseEnter={() => openSubmenu("connectors")}
                    onPointerLeave={() => setActiveSubmenu(null)}
                    onMouseLeave={() => setActiveSubmenu(null)}
                    onFocus={() => {
                      openSubmenu("connectors");
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (connectedConnectors.length > 0) {
                          openSubmenu("connectors");
                        } else {
                          onOpenTool("Connectors");
                        }
                      }}
                      className="composer-menu-item"
                      onPointerEnter={() => openSubmenu("connectors")}
                      onMouseEnter={() => openSubmenu("connectors")}
                    >
                      <PlugsConnected size={18} />
                      <span>
                        <strong>Connections</strong>
                        <small>
                          {connectedConnectors.length > 0
                            ? "Bring in context from your tools"
                            : "No connections added. Add a connection"}
                        </small>
                      </span>
                      {connectedConnectors.length > 0 && <CaretRight size={14} className="composer-menu-item__arrow" />}
                    </button>
                    {activeSubmenu === "connectors" && connectedConnectors.length > 0 && (
                      <div className="composer-submenu-sidebar" role="menu" aria-label="Connections list">
                        <span className="composer-menu__heading">Your connections</span>
                        {connectedConnectors.map((connector) => (
                          <button
                            key={connector.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              const prompt = `Use @${connector.id} to `;
                              onComposerChange(prompt);
                              composerRef.current?.focus();
                              onToggleAddMenu();
                              setActiveSubmenu(null);
                            }}
                          >
                            <div className="composer-submenu-item-content">
                              <ConnectorIcon id={connector.id} />
                              <span>{connector.name}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div
                    className={`composer-menu-item-wrapper${activeSubmenu === "knowledge" ? " is-active" : ""}`}
                    onPointerEnter={() => openSubmenu("knowledge")}
                    onMouseEnter={() => openSubmenu("knowledge")}
                    onPointerLeave={() => setActiveSubmenu(null)}
                    onMouseLeave={() => setActiveSubmenu(null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => onOpenTool("Knowledge")}
                      className="composer-menu-item"
                      onPointerEnter={() => openSubmenu("knowledge")}
                      onMouseEnter={() => openSubmenu("knowledge")}
                    >
                      <Books size={18} />
                      <span>
                        <strong>Knowledge</strong>
                        <small>
                          {knowledgeSources.length > 0
                            ? "Use saved workspace sources"
                            : "No knowledge sources. Add one"}
                        </small>
                      </span>
                      {knowledgeSources.length > 0 && <CaretRight size={14} className="composer-menu-item__arrow" />}
                    </button>
                    {activeSubmenu === "knowledge" && knowledgeSources.length > 0 && (
                      <div className="composer-submenu-sidebar" role="menu" aria-label="Knowledge sources list">
                        <span className="composer-menu__heading">Workspace Knowledge</span>
                        {knowledgeSources.map((source) => (
                          <button
                            key={source.id}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              const prompt = `Use source "${source.title}" to `;
                              onComposerChange(prompt);
                              composerRef.current?.focus();
                              onToggleAddMenu();
                              setActiveSubmenu(null);
                            }}
                          >
                            <div className="composer-submenu-item-content">
                              <Books size={16} />
                              <span className="composer-submenu-item-title" title={source.title}>{source.title}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              ) : null}
            </div>

            {!compactAgentSurface ? <div className="composer-control-anchor composer-control-anchor--permissions">
              <button
                type="button"
                className={`composer-permissions-card${permissionsOpen ? " composer-chip--active composer-trigger--open" : ""}`}
                onClick={() => {
                  setModelOpen(false);
                  onTogglePermissions();
                }}
                aria-expanded={permissionsOpen}
                aria-label="Approval preset"
              >
                <span>{visiblePermissionLabel}</span>
                <CaretDown size={13} />
              </button>
              {permissionsOpen ? (
                <div className="composer-menu composer-permissions" role="menu" aria-label="Approval preset">
                  <span className="composer-menu__heading">How Fable should work</span>
                  {permissionProfiles.map((profile) => {
                    const presentation =
                      PERMISSION_PRESENTATION[
                        profile.label as keyof typeof PERMISSION_PRESENTATION
                      ];
                    const PermissionIcon = presentation?.icon ?? ShieldCheck;
                    return (
                      <button
                        key={profile.label}
                        type="button"
                        role="menuitemradio"
                        aria-checked={permissionLabel === profile.label}
                        className={profile.custom ? "composer-permissions__custom" : undefined}
                        onClick={() => {
                          onSelectPermissionLabel(profile.label);
                          onTogglePermissions();
                        }}
                      >
                        <PermissionIcon
                          className="composer-permissions__icon"
                          size={17}
                          aria-hidden="true"
                        />
                        <span>
                          <strong>{presentation?.label ?? profile.label}</strong>
                          <small>{profile.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div> : null}
          </div>

          <div className="composer-control-group composer-control-group--end">
            {!compactAgentSurface ? <ModelPicker models={models} selectedId={selectedModelId}
              label={selectedModelLabel} effort={selectedReasoningEffort} onSelect={onSelectModel}
              onSelectEffort={onSelectReasoningEffort} open={modelOpen}
              onOpenChange={(open) => { if (open) closeExternalMenus(); setModelOpen(open); }} /> : null}
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
                    aria-describedby="dictation-status dictation-disclosure"
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
              <button
                className={`send-button${isWorking ? " send-button--stop" : ""}`}
                type={isWorking ? "button" : "submit"}
                aria-label={isWorking ? "Stop response" : "Send prompt"}
                onClick={isWorking ? onStop : undefined}
                disabled={!isWorking && (!hasComposerText || voiceListening || voiceTransitioning)}
              >
                {isWorking ? (
                  <Stop size={14} weight="fill" />
                ) : (
                  <PaperPlaneTilt size={20} />
                )}
              </button>
          </div>
        </div>

        {showVoiceFeedback ? (
          <div
            className="voice-feedback"
            data-state={voiceStatus}
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="voice-feedback__indicator" aria-hidden="true" />
            <span id="dictation-status">{voiceMessage}</span>
            {voiceTerminal ? (
              <button type="button" onClick={onDismissVoice}>
                Dismiss
              </button>
            ) : null}
          </div>
        ) : (
          <span id="dictation-status" className="sr-only">
            {voiceMessage}
          </span>
        )}
        <span id="dictation-disclosure" className="sr-only">
          {voiceDisclosure}
        </span>
        {importStatus ? <div className="composer-status" role="status">{importStatus}</div> : null}
      </div>
      </form>
    </>
  );
}
