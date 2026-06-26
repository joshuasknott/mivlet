import { ChangeEvent, FormEvent, RefObject } from "react";
import { At, CaretDown, Paperclip, UploadSimple, Waveform } from "@phosphor-icons/react";
import type { ConnectorManifest } from "@arden/protocol";
import { ShellButton } from "./primitives";
import { ACCEPTED_LOCAL_KNOWLEDGE_FILES } from "../lib/constants";

/**
 * Universal composer. Presentational: all state and handlers are owned by the
 * root orchestration component and passed in as props.
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
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        ref={composerRef}
        value={composerValue}
        onChange={(event) => onComposerChange(event.target.value)}
        placeholder="Ask anything, speak, attach, or run a command..."
        aria-label="Universal composer"
      />
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept={ACCEPTED_LOCAL_KNOWLEDGE_FILES}
        aria-label="Import local knowledge file"
        onChange={onFileChange}
      />
      <div className="composer-actions">
        <div className="composer-left-actions">
          <button
            type="button"
            className={`voice-chip${voiceEnabled ? " voice-chip--active" : ""}`}
            onClick={onToggleVoice}
          >
            <Waveform size={19} weight="bold" />
            <span>Voice</span>
            <CaretDown size={14} weight="bold" />
          </button>
          <ShellButton label="Attach context" onClick={onAttach}>
            <Paperclip size={21} />
            <span>Attach</span>
          </ShellButton>
          <ShellButton label="Open tools" pressed={toolPickerOpen} onClick={onToggleTools}>
            <At size={21} />
            <span>tools</span>
          </ShellButton>
          <ShellButton label="Open slash commands" pressed={commandOpen} onClick={onToggleCommands}>
            <span className="slash">/</span>
            <span>commands</span>
          </ShellButton>
        </div>
        <button className="send-button" type="submit" aria-label="Send prompt">
          <UploadSimple size={25} weight="bold" />
        </button>
      </div>
      {voiceState ? <div className="voice-state" role="status">{voiceState}</div> : null}
      {importStatus ? <div className="composer-status" role="status">{importStatus}</div> : null}
      {toolPickerOpen ? (
        <div className="inline-menu" role="status">
          {connectors.slice(0, 4).map((connector) => (
            <button key={connector.id} type="button" onClick={() => onUseConnector(connector)}>
              {connector.name}
            </button>
          ))}
        </div>
      ) : null}
      {commandOpen ? (
        <div className="inline-menu inline-menu--commands" role="status">
          {["/plan", "/goal", "/remember", "/schedule"].map((command) => (
            <button key={command} type="button" onClick={() => onRunCommand(command)}>
              {command}
            </button>
          ))}
        </div>
      ) : null}
    </form>
  );
}
