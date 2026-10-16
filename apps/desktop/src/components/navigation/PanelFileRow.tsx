import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { MessageAttachments } from "../conversation/MessageAttachments";
import { attachmentPreview } from "../../lib/attachment-previews";
import type { RightPanelTab } from "./right-panel-state";
import type { PanelFile } from "./workspace-panel-data";

export function PanelFileRow({
  file,
  workspaceId,
  onOpen,
}: {
  file: PanelFile;
  workspaceId: string;
  onOpen: (tab: RightPanelTab) => void;
}) {
  if (file.attachment) {
    const { file: attachment, agentId, threadId } = file.attachment;
    const preview = attachmentPreview(workspaceId, threadId, attachment.id);
    if (
      preview ||
      (attachment.availability === "workspace-file" && attachment.relativePath)
    ) {
      return (
        <button
          type="button"
          className="workspace-library__card"
          onClick={() =>
            onOpen({
              id: file.id,
              kind: "file",
              title: file.title,
              ...preview,
              ...(attachment.availability === "workspace-file" &&
              attachment.relativePath
                ? {
                    target: {
                      type: "artifact" as const,
                      workspaceId,
                      agentId,
                      relativePath: attachment.relativePath,
                      title: file.title,
                    },
                  }
                : {}),
            })
          }
        >
          <FileText size={21} aria-hidden="true" />
          <span className="workspace-library__detail">
            <strong>{file.title}</strong>
            <small>{file.detail}</small>
          </span>
        </button>
      );
    }
    return (
      <MessageAttachments
        workspaceId={workspaceId}
        agentId={agentId}
        threadId={threadId}
        attachments={[
          {
            ...attachment,
            availability:
              attachment.availability === "transient"
                ? "knowledge-context"
                : attachment.availability,
          },
        ]}
      />
    );
  }
  return (
    <button
      type="button"
      className="workspace-library__card"
      onClick={() => {
        if (file.tab) onOpen(file.tab);
      }}
    >
      <FileText size={21} aria-hidden="true" />
      <span className="workspace-library__detail">
        <strong>{file.title}</strong>
        <small>{file.detail}</small>
      </span>
    </button>
  );
}
