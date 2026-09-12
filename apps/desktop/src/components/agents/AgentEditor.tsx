import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { UploadSimple } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { FableAgentProfile, FableLearnedTask } from "@fable/protocol";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ProviderModelOption } from "../../lib/provider-models";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { AgentAvatar, DEFAULT_AGENT_COLOR } from "./agent-icons";
import { AVATAR_SHAPES, AVATAR_COLOURS, avatarVariant, createAvatarSeed } from "../../lib/blob-avatar";

import { AgentColourPicker } from "./AgentColourPicker";
const AgentLearningDialog = lazy(() => import("./AgentLearningDialog").then((module) => ({ default: module.AgentLearningDialog })));
import { ModelPicker } from "../ModelPicker";


type AgentDraft = Omit<FableAgentProfile, "id" | "threadId">;

const emptyDraft: AgentDraft = {
  name: "",
  instructions: "",
  modelId: "",
  icon: "agent",
  iconColor: AVATAR_COLOURS[0],
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
  existingAvatarSeeds,
  canDelete,
  onClose,
  onSave,
  onDelete,
  onSkillsChange,
  onUseSkill,
}: {
  open: boolean;
  agent: FableAgentProfile | null;
  models: ProviderModelOption[];
  existingAvatarSeeds?: string[];
  canDelete: boolean;
  onClose: () => void;
  onSave: (draft: AgentDraft) => void;
  onDelete: () => void;
  onSkillsChange?: (tasks: FableLearnedTask[]) => void;
  onUseSkill?: (task: FableLearnedTask) => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const modalRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageRequestRef = useRef(0);
  const [imageError, setImageError] = useState("");
  const [imagePending, setImagePending] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  useModalFocusTrap({ active: open, containerRef: modalRef, initialFocusRef: nameRef, onClose });

  useEffect(() => {
    imageRequestRef.current++;
    setImagePending(false);
    if (!open) return;
    setSkillsOpen(false);
    setModelOpen(false);
    setImageError("");
    const newSeed = agent ? undefined : createAvatarSeed(existingAvatarSeeds);
    setDraft(agent ? {
      name: agent.name,
      instructions: agent.instructions,
      modelId: agent.modelId,
      reasoningEffort: agent.reasoningEffort,
      icon: "agent",
      iconColor: agent.iconColor || DEFAULT_AGENT_COLOR,
      avatarSeed: agent.avatarSeed ?? `blob-v1:${agent.id}`,
      iconImageDataUrl: agent.iconImageDataUrl,
      connectorIds: agent.connectorIds,
      knowledgeSourceIds: agent.knowledgeSourceIds,
      permissionLabel: agent.permissionLabel
    } : { ...emptyDraft, avatarSeed: newSeed, iconColor: AVATAR_COLOURS[avatarVariant(newSeed!)] });
    return () => { imageRequestRef.current++; };
  }, [agent?.id, open]);

  if (!open) return null;

  return (
    <div className="agent-editor-backdrop" role="presentation">
      <div ref={modalRef} className="agent-editor" role="dialog" aria-modal="true" aria-labelledby="agent-editor-title">
        <header className="agent-editor__header">
          <div><h2 id="agent-editor-title">{agent ? `Edit ${agent.name}` : "Create agent"}</h2></div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); if (draft.name.trim() && !imagePending) onSave({ ...draft, name: draft.name.trim(), instructions: draft.instructions.trim() }); }}>
          <div className="agent-editor__identity">
            <AgentAvatar seed={draft.avatarSeed ?? "blob-v1:draft"} imageDataUrl={draft.iconImageDataUrl} color={draft.iconColor} iconSize={80} />
            <label><span>Name</span><input ref={nameRef} required maxLength={80} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="What should this agent be called?" /></label>
          </div>

          <fieldset className="agent-icon-picker">
            <legend className="agent-editor__sr-only">Agent image</legend>
            <div className="agent-shape-picker" role="group" aria-label="Character shape">
              {AVATAR_SHAPES.map((shape, index) => <button key={shape} type="button" aria-label={`${shape} character`}
                aria-pressed={!draft.iconImageDataUrl && avatarVariant(draft.avatarSeed ?? "") === index}
                onClick={() => { imageRequestRef.current++; setImagePending(false); setDraft({ ...draft, iconImageDataUrl: undefined, iconColor: AVATAR_COLOURS[index], avatarSeed: `robot-v3:${index}:${crypto.randomUUID()}` }); }}>
                <AgentAvatar seed={`robot-v3:${index}:preview`} color={AVATAR_COLOURS[index]} iconSize={40} />
              </button>)}
            </div>
            <div className="agent-icon-picker__options">
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
                    const request = ++imageRequestRef.current;
                    setImageError("");
                    setImagePending(true);
                    try {
                      const iconImageDataUrl = await normalizeAgentImage(file);
                      if (request === imageRequestRef.current) setDraft((current) => ({ ...current, iconImageDataUrl }));
                    } catch (error) {
                      if (request === imageRequestRef.current) setImageError(error instanceof Error ? error.message : "That image could not be used.");
                    } finally {
                      if (request === imageRequestRef.current) setImagePending(false);
                    }
                  }}
                />
                <button type="button" disabled={imagePending} onClick={() => imageInputRef.current?.click()}><UploadSimple size={15} />{imagePending ? "Preparing image…" : draft.iconImageDataUrl ? "Replace image" : "Upload image"}</button>
                {draft.iconImageDataUrl ? <button type="button" onClick={() => { imageRequestRef.current++; setImagePending(false); setDraft({ ...draft, iconImageDataUrl: undefined }); }}>Remove image</button> : null}
              </div>
            </div>
            {imageError ? <p className="agent-image-error" role="alert">{imageError}</p> : null}
          </fieldset>

          <AgentColourPicker key={`${agent?.id ?? "new"}:${draft.avatarSeed}`} value={draft.iconColor} onChange={(iconColor) => setDraft({ ...draft, iconColor })} />
          {draft.iconImageDataUrl && <small>Colour applies to the generated portrait when you remove the uploaded image.</small>}

          <label className="agent-editor__field"><span>Instructions</span><textarea rows={3} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} placeholder="How should this agent work with you?" /></label>

          <div className="agent-editor__model-settings">
            <div className="agent-editor__field agent-editor__model"><span>Model</span>
              <ModelPicker models={models} selectedId={draft.modelId} label={models.find((model) => model.id === draft.modelId)?.label ?? (draft.modelId ? "Unavailable model" : "Automatic")}
                effort={draft.reasoningEffort} onSelect={(modelId) => setDraft({ ...draft, modelId, reasoningEffort: undefined })}
                onSelectEffort={(reasoningEffort) => setDraft({ ...draft, reasoningEffort })} open={modelOpen} onOpenChange={setModelOpen} allowAutomatic />
              <small>{draft.modelId ? "This model and reasoning setting apply to this agent's future requests." : "Automatic uses an available connected model."}</small>
            </div>
          </div>


          {agent && onSkillsChange ? <button type="button" className="agent-editor__skills" onClick={() => setSkillsOpen(true)}>Skills for {agent.name}<span>{agent.learnedTasks?.length ?? 0}</span></button> : null}

          <footer className="agent-editor__footer">
            {agent && canDelete ? <button className="agent-editor__delete" type="button" onClick={onDelete}><Trash size={15} />Delete</button> : <span />}
            <div><button type="button" onClick={onClose}>Cancel</button><button className="agent-editor__save" type="submit" disabled={!draft.name.trim() || imagePending}>{agent ? "Save changes" : "Create agent"}</button></div>
          </footer>
        </form>
        {agent && onSkillsChange && skillsOpen ? <Suspense fallback={null}><AgentLearningDialog open={skillsOpen} agent={agent}
          onClose={() => setSkillsOpen(false)} onChange={onSkillsChange} onRun={(task) => {
            setSkillsOpen(false); onClose(); onUseSkill?.(task);
          }} /></Suspense> : null}
      </div>
    </div>
  );
}
