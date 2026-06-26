import { ChangeEvent, FormEvent, RefObject } from "react";
import {
  ArrowUp,
  CaretUp,
  Paperclip,
  SlidersHorizontal,
  Waveform
} from "@phosphor-icons/react";
import type { ConnectorManifest } from "@arden/protocol";
import { ACCEPTED_LOCAL_KNOWLEDGE_FILES } from "../lib/constants";

/**
 * Universal composer (Codex-style, minimal).
 *
 * Controls are icon-led with upward-opening dropdowns for tools and commands.
 * The voice control uses an icon + dropdown affordance rather than a verbose
 * "Voice" text label. Presentational only — all state/handlers come from props.
 */
export function Composer({
  composerRef,
  fileInputRef,
  composerValue,
  onComposerChange,
  onSubmit,
  voiceEnabled,
  onToggleVoice,
  onAttach,
  toolPickerOpen,
  commandOpen,
  onToggleTools,
  onToggleCommands,
  connectors,
  onUseConnector,
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
  toolPickerOpen: boolean;
  commandOpen: boolean;
  onToggleTools: () => void;
  onToggleCommands: () => void;
  connectors: ConnectorManifest[];
  onUseConnector: (connector: ConnectorManifest) => void;
  onRunCommand: (command: string) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  voiceState?: string;
  importStatus?: string | null;
}) {
  return (
    <form className="composer composer--minimal" onSubmit={onSubmit}>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept={ACCEPTED_LOCAL_KNOWLEDGE_FILES}
        aria-label="Import local knowledge file"
        onChange={onFileChange}
      />
      <div className="composer-field">
        <textarea
          ref={composerRef}
          className="composer-input"
          value={composerValue}
          onChange={(event) => onComposerChange(event.target.value)}
          placeholder="Ask anything, or run a command..."
          aria-label="Universal composer"
          rows={1}
        />
        <button className="send-button" type="submit" aria-label="Send prompt">
          <ArrowUp size={20} weight="bold" />
        </button>
      </div>

      <div className="composer-controls">
        <div className="composer-control-group">
          <button
            type="button"
            className={`composer-chip${voiceEnabled ? " composer-chip--active" : ""}`}
            onClick={onToggleVoice}
            aria-pressed={voiceEnabled}
            aria-label={voiceEnabled ? "Pause voice input" : "Start voice input"}
          >
            <Waveform size={16} weight="bold" />
            <CaretUp size={11} weight="bold" />
          </button>
          <button
            type="button"
            className="composer-chip"
            onClick={onAttach}
            aria-label="Attach context"
          >
            <Paperclip size={16} />
          </button>
          <button
            type="button"
            className={`composer-chip${toolPickerOpen ? " composer-chip--active" : ""}`}
            onClick={onToggleTools}
            aria-pressed={toolPickerOpen}
            aria-label="Open tools"
          >
            <SlidersHorizontal size={16} />
            <CaretUp size={11} weight="bold" />
          </button>
          <button
            type="button"
            className={`composer-chip${commandOpen ? " composer-chip--active" : ""}`}
            onClick={onToggleCommands}
            aria-pressed={commandOpen}
            aria-label="Open slash commands"
          >
            <span className="composer-chip__slash">/</span>
            <CaretUp size={11} weight="bold" />
          </button>
        </div>
        <span className="composer-hint">Enter to send</span>
      </div>

      {toolPickerOpen ? (
        <div className="composer-menu composer-menu--up" role="listbox" aria-label="Available tools">
          {connectors.slice(0, 4).map((connector) => (
            <button
              key={connector.id}
              type="button"
              onClick={() => onUseConnector(connector)}
            >
              <span>{connector.name}</span>
              <small>{connector.healthSummary}</small>
            </button>
          ))}
        </div>
      ) : null}
      {commandOpen ? (
        <div
          className="composer-menu composer-menu--up composer-menu--commands"
          role="listbox"
          aria-label="Slash commands"
        >
          {["/plan", "/goal", "/remember", "/schedule"].map((command) => (
            <button key={command} type="button" onClick={() => onRunCommand(command)}>
              <span className="composer-menu__command">{command}</span>
            </button>
          ))}
        </div>
      ) : null}

      {voiceState ? <div className="voice-state" role="status">{voiceState}</div> : null}
      {importStatus ? <div className="composer-status" role="status">{importStatus}</div> : null}
    </form>
  );
}
