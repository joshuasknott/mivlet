import { ChangeEvent, FormEvent, KeyboardEvent, RefObject, useMemo, useState } from "react";
import { ArrowUp } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { Books } from "@phosphor-icons/react/dist/csr/Books";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { FileArrowUp } from "@phosphor-icons/react/dist/csr/FileArrowUp";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { HandPalm } from "@phosphor-icons/react/dist/csr/HandPalm";
import { Microphone } from "@phosphor-icons/react/dist/csr/Microphone";
import { PlugsConnected } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import { Stop } from "@phosphor-icons/react/dist/csr/Stop";
import { Terminal } from "@phosphor-icons/react/dist/csr/Terminal";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { ACCEPTED_COMPOSER_ATTACHMENTS } from "../lib/constants";
import { PERMISSION_PROFILES, type PermissionProfile } from "../lib/agent-run";
import type { ProviderModelOption } from "../lib/provider-models";
import type { VoiceStatus } from "../hooks/useVoice";
import type { ComposerAttachment } from "../lib/types";
import { ConnectorIcon } from "./ConnectorIcon";
import { ProviderIcon } from "./ProviderIcon";

const COMMANDS = ["/mission", "/plan", "/goal", "/remember", "/schedule", "/stop"] as const;

const PERMISSION_PRESENTATION = {
  "Read Only": {
    label: "Ask for approval",
    description: "Always ask before Fable changes files or takes external actions.",
    icon: HandPalm
  },
  "Ask Me": {
    label: "Approve for me",
    description: "Fable handles routine work and asks before sensitive actions.",
    icon: ShieldCheck
  },
  "Work Freely": {
    label: "Full access",
    description: "Use Fable's broadest in-house permission profile.",
    icon: ShieldWarning
  },
  Custom: {
    label: "Custom",
    description: "Use the permissions you set in Fable.",
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
  onRunCommand,
  onFileChange,
  importStatus,
  models,
  selectedModelId,
  selectedModelLabel,
  onSelectModel,
  permissionLabel,
  permissionProfiles,
  onSelectPermissionLabel,
  inThread = false,
  connectedConnectors = [],
  knowledgeSources = [],
  attachments = [],
  onRemoveAttachment
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
  onOpenTool: (tool: "Connectors" | "Knowledge" | "Schedules") => void;
  onRunCommand: (command: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  importStatus?: string | null;
  /** Provider-aware choices across every connected runnable backend. */
  models: ProviderModelOption[];
  /** Currently selected model id, or "" when none is selected/available. */
  selectedModelId: string;
  /** Label to show on the model chip when a model is selected. */
  selectedModelLabel: string;
  onSelectModel: (modelId: string) => void;
  /** Label of the active approval preset (drives the chip text). */
  permissionLabel: string;
  /** Approval presets available in the picker. */
  permissionProfiles: readonly PermissionProfile[];
  onSelectPermissionLabel: (label: string) => void;
  inThread?: boolean;
  connectedConnectors?: { id: string; name: string; status: string }[];
  knowledgeSources?: { id: string; title: string; provenance: string; connectorId?: string }[];
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (attachmentId: string) => void;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<"connectors" | "knowledge" | "commands" | null>(null);
  const activePermissionPresentation =
    PERMISSION_PRESENTATION[permissionLabel as keyof typeof PERMISSION_PRESENTATION];
  const visiblePermissionLabel = activePermissionPresentation?.label ?? permissionLabel;
  const ActivePermissionIcon = activePermissionPresentation?.icon ?? ShieldCheck;
  const selectedModel = models.find((model) => model.id === selectedModelId);

  const closeExternalMenus = () => {
    if (addMenuOpen) onToggleAddMenu();
    if (permissionsOpen) onTogglePermissions();
    setActiveSubmenu(null);
  };
  const openSubmenu = (submenu: "connectors" | "knowledge" | "commands") => {
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
    if (query.startsWith("/")) {
      return COMMANDS.filter((command) => command.startsWith(query)).map((command) => ({
        id: command,
        label: command,
        description:
          command === "/mission"
            ? "Run 2–6 tasks, with an optional all/any continuation"
            : command === "/goal"
            ? "Create a goal"
            : command === "/schedule"
              ? "Create a schedule"
              : command === "/remember"
                ? "Save memory"
                : command === "/stop"
                  ? "Stop current work"
                : "Create a plan",
        value: command
      }));
    }
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
        className={`composer-glow ${menuPlacementClass}`}
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
            placeholder="Ask anything..."
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
                <Plus size={21} weight="bold" />
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
                      disabled={connectedConnectors.length === 0}
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
                        <strong>Connectors</strong>
                        <small>
                          {connectedConnectors.length > 0
                            ? "Bring in context from your tools"
                            : "No connectors added. Add a connector"}
                        </small>
                      </span>
                      {connectedConnectors.length > 0 && <CaretRight size={14} className="composer-menu-item__arrow" />}
                    </button>
                    {activeSubmenu === "connectors" && connectedConnectors.length > 0 && (
                      <div className="composer-submenu-sidebar" role="menu" aria-label="Connectors list">
                        <span className="composer-menu__heading">Your Connectors</span>
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
                      disabled={knowledgeSources.length === 0}
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

                  <div className="composer-add-menu__divider" aria-hidden="true" />

                  <div
                    className={`composer-menu-item-wrapper${activeSubmenu === "commands" ? " is-active" : ""}`}
                    onPointerEnter={() => openSubmenu("commands")}
                    onMouseEnter={() => openSubmenu("commands")}
                    onPointerLeave={() => setActiveSubmenu(null)}
                    onMouseLeave={() => setActiveSubmenu(null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="composer-menu-item"
                      onPointerEnter={() => openSubmenu("commands")}
                      onMouseEnter={() => openSubmenu("commands")}
                    >
                      <Terminal size={18} />
                      <span>
                        <strong>Commands</strong>
                        <small>Run prompt-level automations</small>
                      </span>
                      <CaretRight size={14} className="composer-menu-item__arrow" />
                    </button>
                    {activeSubmenu === "commands" && (
                      <div className="composer-submenu-sidebar composer-submenu-sidebar--commands composer-submenu-sidebar--align-bottom" role="menu" aria-label="Commands list">
                        <span className="composer-menu__heading">Available Commands</span>
                        {COMMANDS.map((command) => (
                          <button
                            key={command}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              onRunCommand(command);
                              onToggleAddMenu();
                              setActiveSubmenu(null);
                            }}
                          >
                            <span className="composer-menu__command">{command}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                </div>
              ) : null}
            </div>

            <div className="composer-control-anchor composer-control-anchor--permissions">
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
                <ActivePermissionIcon size={19} aria-hidden="true" />
                <span>{visiblePermissionLabel}</span>
                <CaretDown size={15} weight="bold" />
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
                          <small>{presentation?.description ?? profile.description}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          <div className="composer-control-group composer-control-group--end">
            <div className="composer-control-anchor composer-control-anchor--model">
              <button
                type="button"
                className={`composer-model${modelOpen ? " composer-trigger--open" : ""}`}
                aria-label="Select model"
                aria-expanded={modelOpen}
                onClick={() => {
                  closeExternalMenus();
                  setModelOpen((open) => !open);
                }}
              >
                {selectedModel ? (
                  <span className="composer-model__provider" aria-hidden="true">
                    <ProviderIcon provider={selectedModel.providerId} size={16} />
                  </span>
                ) : null}
                <span>{selectedModelLabel}</span>
                <CaretDown size={16} weight="bold" />
              </button>
              {modelOpen ? (
                <div className="composer-menu composer-model-menu" role="menu" aria-label="Models">
                  {models.length === 0 ? (
                    <span className="composer-menu__heading">No models available</span>
                  ) : (
                    models.map((option) => {
                      const disabled = !option.available;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selectedModelId === option.id}
                          aria-label={`${option.providerLabel} ${option.label}${disabled ? ", unavailable" : ""}`}
                          disabled={disabled}
                          onClick={() => {
                            if (disabled) return;
                            onSelectModel(option.id);
                            setModelOpen(false);
                          }}
                        >
                          <span className="composer-model-menu__provider" aria-hidden="true">
                            <ProviderIcon provider={option.providerId} size={18} />
                          </span>
                          <strong>{option.label}</strong>
                        </button>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
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
                    <Microphone size={17} weight="fill" />
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
            <button className="send-button" type="submit" aria-label="Send prompt">
              <ArrowUp size={19} weight="bold" />
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
