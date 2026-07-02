import { ChangeEvent, FormEvent, KeyboardEvent, RefObject, useState } from "react";
import {
  ArrowUp,
  Books,
  CaretDown,
  CaretRight,
  FileArrowUp,
  GearSix,
  HandPalm,
  Microphone,
  PlugsConnected,
  Plus,
  ShieldCheck,
  ShieldWarning,
  Stop,
  X,
  Terminal
} from "@phosphor-icons/react";
import { ACCEPTED_LOCAL_KNOWLEDGE_FILES } from "../lib/constants";
import { PERMISSION_PROFILES, type PermissionProfile } from "../lib/agent-run";
import type { VoiceStatus } from "../hooks/useVoice";
import { ConnectorIcon } from "./ConnectorIcon";

const COMMANDS = ["/plan", "/goal", "/remember", "/schedule"] as const;

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
  knowledgeSources = []
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
  /** Models the connected backend exposes (id + label + availability). */
  models: { id: string; label: string; available: boolean }[];
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
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<"connectors" | "knowledge" | "commands" | null>(null);
  const activePermissionPresentation =
    PERMISSION_PRESENTATION[permissionLabel as keyof typeof PERMISSION_PRESENTATION];
  const visiblePermissionLabel = activePermissionPresentation?.label ?? permissionLabel;
  const ActivePermissionIcon = activePermissionPresentation?.icon ?? ShieldCheck;

  const closeExternalMenus = () => {
    if (addMenuOpen) onToggleAddMenu();
    if (permissionsOpen) onTogglePermissions();
    setActiveSubmenu(null);
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

  return (
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
        accept={ACCEPTED_LOCAL_KNOWLEDGE_FILES}
        aria-label="Import local knowledge file"
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
                <Plus size={18} weight="bold" />
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
                    onMouseEnter={() => {
                      if (connectedConnectors.length > 0) {
                        setActiveSubmenu("connectors");
                      }
                    }}
                    onMouseLeave={() => setActiveSubmenu(null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={connectedConnectors.length === 0}
                      onClick={() => onOpenTool("Connectors")}
                      className="composer-menu-item"
                      onMouseEnter={() => {
                        if (connectedConnectors.length > 0) {
                          setActiveSubmenu("connectors");
                        }
                      }}
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
                              const prompt = `Use ${connector.name} to `;
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
                    onMouseEnter={() => {
                      if (knowledgeSources.length > 0) {
                        setActiveSubmenu("knowledge");
                      }
                    }}
                    onMouseLeave={() => setActiveSubmenu(null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={knowledgeSources.length === 0}
                      onClick={() => onOpenTool("Knowledge")}
                      className="composer-menu-item"
                      onMouseEnter={() => {
                        if (knowledgeSources.length > 0) {
                          setActiveSubmenu("knowledge");
                        }
                      }}
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
                    onMouseEnter={() => {
                      setActiveSubmenu("commands");
                    }}
                    onMouseLeave={() => setActiveSubmenu(null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="composer-menu-item"
                      onMouseEnter={() => {
                        setActiveSubmenu("commands");
                      }}
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
                <ActivePermissionIcon size={16} aria-hidden="true" />
                <span>{visiblePermissionLabel}</span>
                <CaretDown size={13} weight="bold" />
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
                <span>{selectedModelLabel}</span>
                <CaretDown size={14} weight="bold" />
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
                          disabled={disabled}
                          onClick={() => {
                            if (disabled) return;
                            onSelectModel(option.id);
                            setModelOpen(false);
                          }}
                        >
                          <strong>{option.label}</strong>
                          {disabled ? <small>Unavailable</small> : null}
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
              <ArrowUp size={16} weight="bold" />
            </button>
          </div>
        </div>

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
        <span id="dictation-disclosure" className="sr-only">
          {voiceDisclosure}
        </span>
        {importStatus ? <div className="composer-status" role="status">{importStatus}</div> : null}
      </div>
    </form>
  );
}
