import { ChangeEvent, FormEvent, KeyboardEvent, RefObject, useState } from "react";
import {
  ArrowUp,
  Books,
  CalendarBlank,
  CaretDown,
  FileArrowUp,
  Microphone,
  PlugsConnected,
  Plus,
  ShieldCheck
} from "@phosphor-icons/react";
import { ACCEPTED_LOCAL_KNOWLEDGE_FILES } from "../lib/constants";
import { PERMISSION_PROFILES, type PermissionProfile } from "../lib/agent-run";

const COMMANDS = ["/plan", "/goal", "/remember", "/schedule"] as const;

export function Composer({
  composerRef,
  fileInputRef,
  composerValue,
  onComposerChange,
  onSubmit,
  voiceEnabled,
  onToggleVoice,
  onAttach,
  addMenuOpen,
  permissionsOpen,
  onToggleAddMenu,
  onTogglePermissions,
  onOpenTool,
  onRunCommand,
  onFileChange,
  voiceState,
  importStatus,
  models,
  selectedModelId,
  selectedModelLabel,
  onSelectModel,
  permissionLabel,
  permissionProfiles,
  onSelectPermissionLabel,
  inThread = false
}: {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  onAttach: () => void;
  addMenuOpen: boolean;
  permissionsOpen: boolean;
  onToggleAddMenu: () => void;
  onTogglePermissions: () => void;
  onOpenTool: (tool: "Connectors" | "Knowledge" | "Schedules") => void;
  onRunCommand: (command: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  voiceState?: string;
  importStatus?: string | null;
  /** Models the connected backend exposes (id + label + availability). */
  models: { id: string; label: string; available: boolean }[];
  /** Currently selected model id, or "" when none is selected/available. */
  selectedModelId: string;
  /** Label to show on the model chip when a model is selected. */
  selectedModelLabel: string;
  onSelectModel: (modelId: string) => void;
  /** Label of the active permission profile (drives the chip text). */
  permissionLabel: string;
  /** Permission profiles available in the picker. */
  permissionProfiles: readonly PermissionProfile[];
  onSelectPermissionLabel: (label: string) => void;
  inThread?: boolean;
}) {
  const [modelOpen, setModelOpen] = useState(false);

  const closeExternalMenus = () => {
    if (addMenuOpen) onToggleAddMenu();
    if (permissionsOpen) onTogglePermissions();
  };

  const isNewThread = !inThread;
  const menuPlacementClass = isNewThread ? "composer-glow--new-thread" : "composer-glow--in-thread";

  return (
    <form className={`composer-glow ${menuPlacementClass}`} onSubmit={onSubmit}>
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
                  <button type="button" role="menuitem" onClick={() => onOpenTool("Connectors")}>
                    <PlugsConnected size={18} />
                    <span><strong>Connectors</strong><small>Bring in context from your tools</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => onOpenTool("Knowledge")}>
                    <Books size={18} />
                    <span><strong>Knowledge</strong><small>Use saved workspace sources</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => onOpenTool("Schedules")}>
                    <CalendarBlank size={18} />
                    <span><strong>Schedules</strong><small>Choose or create an automation</small></span>
                  </button>
                  <div className="composer-add-menu__divider" aria-hidden="true" />
                  <span className="composer-menu__heading">Commands</span>
                  <div className="composer-add-menu__commands">
                    {COMMANDS.map((command) => (
                      <button key={command} type="button" role="menuitem" onClick={() => onRunCommand(command)}>
                        <span className="composer-menu__command">{command}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="composer-control-anchor">
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

            <div className="composer-control-anchor composer-control-anchor--permissions">
              <button
                type="button"
                className={`composer-permissions-card${permissionsOpen ? " composer-chip--active composer-trigger--open" : ""}`}
                onClick={() => {
                  setModelOpen(false);
                  onTogglePermissions();
                }}
                aria-expanded={permissionsOpen}
                aria-label="Select permissions"
              >
                <ShieldCheck size={16} weight="bold" />
                <span>{permissionLabel}</span>
                <CaretDown size={13} weight="bold" />
              </button>
              {permissionsOpen ? (
                <div className="composer-menu composer-permissions" role="menu" aria-label="Permission level">
                  <span className="composer-menu__heading">Permission level</span>
                  {permissionProfiles.map((profile) => (
                    <button
                      key={profile.label}
                      type="button"
                      role="menuitemradio"
                      aria-checked={permissionLabel === profile.label}
                      onClick={() => {
                        onSelectPermissionLabel(profile.label);
                        onTogglePermissions();
                      }}
                    >
                      <span><strong>{profile.label}</strong><small>{profile.description}</small></span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="composer-control-group composer-control-group--end">
            <button
              type="button"
              className={`composer-chip${voiceEnabled ? " composer-chip--active" : ""}`}
              onClick={onToggleVoice}
              aria-pressed={voiceEnabled}
              aria-label={voiceEnabled ? "Pause voice input" : "Start voice input"}
            >
              <Microphone size={17} weight="fill" />
            </button>
            <button className="send-button" type="submit" aria-label="Send prompt">
              <ArrowUp size={16} weight="bold" />
            </button>
          </div>
        </div>

        {voiceState ? <div className="voice-state" role="status">{voiceState}</div> : null}
        {importStatus ? <div className="composer-status" role="status">{importStatus}</div> : null}
      </div>
    </form>
  );
}
