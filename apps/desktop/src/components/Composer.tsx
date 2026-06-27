import { ChangeEvent, FormEvent, RefObject, useState } from "react";
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

const COMMANDS = ["/plan", "/goal", "/remember", "/schedule"] as const;
const MODELS = ["Arden Pro", "Arden Fast", "Arden Reasoning"] as const;
const PERMISSION_PROFILES = [
  { label: "Full access", description: "Run permitted actions without asking each time" },
  { label: "Standard access", description: "Ask before sensitive or external actions" },
  { label: "Confirm every action", description: "Request approval before using any tool" }
] as const;

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
  importStatus
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
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [model, setModel] = useState("Arden Pro");
  const [permissionMode, setPermissionMode] = useState("Full access");

  const closeExternalMenus = () => {
    if (addMenuOpen) onToggleAddMenu();
    if (permissionsOpen) onTogglePermissions();
  };

  return (
    <form className="composer-glow" onSubmit={onSubmit}>
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
                <span>{model}</span>
                <CaretDown size={14} weight="bold" />
              </button>
              {modelOpen ? (
                <div className="composer-menu composer-model-menu" role="menu" aria-label="Models">
                  {MODELS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="menuitemradio"
                      aria-checked={model === option}
                      onClick={() => {
                        setModel(option);
                        setModelOpen(false);
                      }}
                    >
                      <strong>{option}</strong>
                    </button>
                  ))}
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
                <span>{permissionMode}</span>
                <CaretDown size={13} weight="bold" />
              </button>
              {permissionsOpen ? (
                <div className="composer-menu composer-permissions" role="menu" aria-label="Permission level">
                  <span className="composer-menu__heading">Permission level</span>
                  {PERMISSION_PROFILES.map((profile) => (
                    <button
                      key={profile.label}
                      type="button"
                      role="menuitemradio"
                      aria-checked={permissionMode === profile.label}
                      onClick={() => {
                        setPermissionMode(profile.label);
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
              <ArrowUp size={20} weight="bold" />
            </button>
          </div>
        </div>

        {voiceState ? <div className="voice-state" role="status">{voiceState}</div> : null}
        {importStatus ? <div className="composer-status" role="status">{importStatus}</div> : null}
      </div>
    </form>
  );
}
