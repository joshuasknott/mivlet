import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { UploadSimple } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { ApprovalPresetLabel, ConnectorManifest, FableAgentProfile, KnowledgeSource } from "@fable/protocol";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ProviderModelOption } from "../../lib/provider-models";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { AgentAvatar, DEFAULT_AGENT_COLOR, agentColorPalette } from "./agent-icons";

const permissionOptions: ApprovalPresetLabel[] = ["Ask Me", "Read Only", "Work Freely", "Custom"];

type AgentDraft = Omit<FableAgentProfile, "id" | "threadId">;

const emptyDraft: AgentDraft = {
  name: "",
  instructions: "",
  modelId: "",
  icon: "agent",
  iconColor: DEFAULT_AGENT_COLOR,
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me"
};

const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;
const NORMALIZED_AGENT_IMAGE_SIZE = 256;

function readImageFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

async function normalizeAgentImage(file: File) {
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size > MAX_AGENT_IMAGE_BYTES) {
    throw new Error("Choose an image smaller than 5 MB.");
  }

  const source = await readImageFile(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const candidate = new Image();
    candidate.onload = () => resolve(candidate);
    candidate.onerror = () => reject(new Error("That image could not be opened."));
    candidate.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = NORMALIZED_AGENT_IMAGE_SIZE;
  canvas.height = NORMALIZED_AGENT_IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable.");
  const crop = Math.min(image.naturalWidth, image.naturalHeight);
  context.drawImage(
    image,
    (image.naturalWidth - crop) / 2,
    (image.naturalHeight - crop) / 2,
    crop,
    crop,
    0,
    0,
    NORMALIZED_AGENT_IMAGE_SIZE,
    NORMALIZED_AGENT_IMAGE_SIZE
  );
  return canvas.toDataURL("image/webp", 0.86);
}

export function AgentEditor({
  open,
  agent,
  models,
  connectors,
  knowledgeSources,
  suggestedColor,
  canDelete,
  onClose,
  onSave,
  onDelete
}: {
  open: boolean;
  agent: FableAgentProfile | null;
  models: ProviderModelOption[];
  connectors: ConnectorManifest[];
  knowledgeSources: KnowledgeSource[];
  suggestedColor: string;
  canDelete: boolean;
  onClose: () => void;
  onSave: (draft: AgentDraft) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const modalRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState("");
  useModalFocusTrap({ active: open, containerRef: modalRef, initialFocusRef: nameRef, onClose });

  useEffect(() => {
    if (!open) return;
    setImageError("");
    setDraft(agent ? {
      name: agent.name,
      instructions: agent.instructions,
      modelId: agent.modelId,
      icon: "agent",
      iconColor: agent.iconColor || suggestedColor,
      iconImageDataUrl: agent.iconImageDataUrl,
      connectorIds: agent.connectorIds,
      knowledgeSourceIds: agent.knowledgeSourceIds,
      permissionLabel: agent.permissionLabel
    } : { ...emptyDraft, iconColor: suggestedColor });
  }, [agent, open, suggestedColor]);

  if (!open) return null;
  const toggle = (key: "connectorIds" | "knowledgeSourceIds", id: string) => {
    setDraft((current) => ({
      ...current,
      [key]: current[key].includes(id) ? current[key].filter((value) => value !== id) : [...current[key], id]
    }));
  };

  return (
    <div className="agent-editor-backdrop" role="presentation">
      <div ref={modalRef} className="agent-editor" role="dialog" aria-modal="true" aria-labelledby="agent-editor-title">
        <header className="agent-editor__header">
          <div><span>Agent</span><h2 id="agent-editor-title">{agent ? "Edit agent" : "Create agent"}</h2></div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); if (draft.name.trim()) onSave({ ...draft, name: draft.name.trim(), instructions: draft.instructions.trim() }); }}>
          <div className="agent-editor__identity">
            <AgentAvatar color={draft.iconColor} imageDataUrl={draft.iconImageDataUrl} iconSize={46} />
            <label><span>Name</span><input ref={nameRef} required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="What should this agent be called?" /></label>
          </div>

          <fieldset className="agent-icon-picker">
            <legend>Agent icon</legend>
            <div className="agent-icon-picker__options">
              <div className="agent-color-picker" aria-label="Agent icon colour">
                {agentColorPalette.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={draft.iconColor.toUpperCase() === option.value.toUpperCase() ? "is-selected" : ""}
                    style={{ "--agent-swatch": option.value } as CSSProperties}
                    onClick={() => setDraft({ ...draft, iconColor: option.value })}
                    aria-label={`${option.label} icon`}
                    aria-pressed={draft.iconColor.toUpperCase() === option.value.toUpperCase()}
                  />
                ))}
              </div>
              <div className="agent-image-upload">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="Upload agent image"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    setImageError("");
                    try {
                      const iconImageDataUrl = await normalizeAgentImage(file);
                      setDraft((current) => ({ ...current, iconImageDataUrl }));
                    } catch (error) {
                      setImageError(error instanceof Error ? error.message : "That image could not be used.");
                    }
                  }}
                />
                <button type="button" onClick={() => imageInputRef.current?.click()}><UploadSimple size={15} />{draft.iconImageDataUrl ? "Replace image" : "Upload image"}</button>
                {draft.iconImageDataUrl ? <button type="button" onClick={() => setDraft({ ...draft, iconImageDataUrl: undefined })}>Remove image</button> : null}
              </div>
            </div>
            <small>Choose a colour for Fable's agent mark, or upload your own square image.</small>
            {imageError ? <p className="agent-image-error" role="alert">{imageError}</p> : null}
          </fieldset>

          <label className="agent-editor__field"><span>Instructions</span><textarea rows={5} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="Describe how this agent should think, communicate, and work." /></label>

          <div className="agent-editor__grid">
            <label className="agent-editor__field"><span>Model</span><select aria-label="Model" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}><option value="">Automatic</option>{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select><small>Automatic uses the best available connected model.</small></label>
            <label className="agent-editor__field"><span>Permissions</span><select aria-label="Permissions" value={draft.permissionLabel} onChange={(event) => setDraft({ ...draft, permissionLabel: event.target.value as ApprovalPresetLabel })}>{permissionOptions.map((option) => <option key={option}>{option}</option>)}</select><small>Fable still asks before consequential actions.</small></label>
          </div>

          <fieldset className="agent-editor__choices"><legend>Connections</legend>{connectors.filter((connector) => connector.id !== "local-files").length ? connectors.filter((connector) => connector.id !== "local-files").map((connector) => <label key={connector.id}><input type="checkbox" checked={draft.connectorIds.includes(connector.id)} onChange={() => toggle("connectorIds", connector.id)} /><span>{connector.name}</span><small>{connector.status === "connected" ? "Connected" : "Not connected"}</small></label>) : <p>No connections are available yet.</p>}</fieldset>

          <fieldset className="agent-editor__choices"><legend>Knowledge pool</legend>{knowledgeSources.length ? knowledgeSources.map((source) => <label key={source.id}><input type="checkbox" checked={draft.knowledgeSourceIds.includes(source.id)} onChange={() => toggle("knowledgeSourceIds", source.id)} /><span>{source.title}</span></label>) : <p>Add knowledge to make it available to this agent.</p>}</fieldset>

          <footer className="agent-editor__footer">
            {agent && canDelete ? <button className="agent-editor__delete" type="button" onClick={onDelete}><Trash size={15} />Delete</button> : <span />}
            <div><button type="button" onClick={onClose}>Cancel</button><button className="agent-editor__save" type="submit" disabled={!draft.name.trim()}>{agent ? "Save changes" : "Create agent"}</button></div>
          </footer>
        </form>
      </div>
    </div>
  );
}
