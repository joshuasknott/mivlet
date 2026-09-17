import { useState } from "react";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import type { Spine } from "@mivlet/protocol";
import { artifactSize } from "../../lib/computer-artifacts";
import { SearchFileDialog } from "../search/SearchFileDialog";
import { attachmentPreview } from "../../lib/attachment-previews";
import "../ComputerArtifacts.css";

export function MessageAttachments({ attachments, workspaceId, agentId, threadId }: {
  attachments: readonly Spine.Conversations.ConversationAttachmentMetadata[];
  workspaceId: string;
  agentId: string;
  threadId?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const attachment = attachments.find(file => file.id === selected);
  const preview = attachment && threadId ? attachmentPreview(workspaceId, threadId, attachment.id) : undefined;
  return <>
    <ul className="conversation-message__attachments" aria-label="Attached files">{attachments.map(file => {
      const content = threadId ? attachmentPreview(workspaceId, threadId, file.id) : undefined;
      const available = Boolean(content) || file.availability === "workspace-file" && Boolean(file.relativePath) && agentId !== "unavailable-author";
      const description = content ? "Preview attachment" : available ? file.relativePath : file.availability === "project-file" ? "Saved to this project · Reattach to preview" : "Original not retained · Reattach to preview";
      return <li key={file.id} className={content?.imageDataUrl ? "computer-artifact--image" : undefined}><button type="button" className="computer-artifact__open" disabled={!available}
        aria-label={`Preview ${file.name}`} title={description} onClick={() => setSelected(file.id)}>
        {content?.imageDataUrl ? <span className="computer-artifact__thumbnail"><img src={content.imageDataUrl} alt={file.name} loading="lazy" /></span> : <FileText size={22} aria-hidden className="computer-artifact__icon" />}
        <span className="computer-artifact__copy"><strong className="computer-artifact__title">{file.name}</strong>
          <small className="computer-artifact__meta">{file.name.split(".").at(-1)?.toUpperCase()} · {artifactSize(file.sizeBytes)}</small>
          {!content && <small className="computer-artifact__meta">{description}</small>}
        </span>
      </button></li>;
    })}</ul>
    {attachment && preview ? <SearchFileDialog key={attachment.id} title={attachment.name} {...preview} onClose={() => setSelected(null)} /> : attachment?.relativePath && attachment.availability === "workspace-file" && agentId !== "unavailable-author" ? <SearchFileDialog
      key={`${workspaceId}:${agentId}:${attachment.id}`} title={attachment.name}
      target={{ type: "artifact", workspaceId, agentId, relativePath: attachment.relativePath, title: attachment.name }}
      onClose={() => setSelected(null)} /> : null}
  </>;
}
