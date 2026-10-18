import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FilePdf } from "@phosphor-icons/react/dist/csr/FilePdf";
import { FileXls } from "@phosphor-icons/react/dist/csr/FileXls";
import { FileImage } from "@phosphor-icons/react/dist/csr/FileImage";
import { FileCode } from "@phosphor-icons/react/dist/csr/FileCode";
import { attachmentPreview } from "../../lib/attachment-previews";
import type { RightPanelTab } from "./right-panel-state";
import type { PanelFile } from "./workspace-panel-data";
import "./panel-file-row.css";

/** Compact metadata rows never load file contents. Every format opens the same inspector. */
export function PanelFileRow({
  file,
  workspaceId,
  onOpen,
}: {
  file: PanelFile;
  workspaceId: string;
  onOpen: (tab: RightPanelTab) => void;
}) {
  const extension = file.title.split(".").at(-1)?.toLowerCase();
  const format =
    extension === "pdf"
      ? "pdf"
      : ["xlsx", "xls", "csv"].includes(extension ?? "")
        ? "sheet"
        : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")
          ? "image"
          : ["json", "ts", "tsx", "js", "html", "css", "yaml", "yml"].includes(
                extension ?? "",
              )
            ? "code"
            : "document";
  const Icon = {
    pdf: FilePdf,
    sheet: FileXls,
    image: FileImage,
    code: FileCode,
    document: FileText,
  }[format];
  let target = file.tab;
  if (file.attachment) {
    const { file: attachment, agentId, threadId } = file.attachment;
    const preview = attachmentPreview(workspaceId, threadId, attachment.id);
    const retained =
      attachment.availability === "workspace-file" &&
      attachment.relativePath &&
      agentId !== "unavailable-author";
    target =
      preview || retained
        ? {
            id: file.id,
            kind: "file",
            title: file.title,
            ...preview,
            ...(retained
              ? {
                  target: {
                    type: "artifact" as const,
                    workspaceId,
                    agentId,
                    relativePath: attachment.relativePath!,
                    title: file.title,
                  },
                }
              : {}),
          }
        : undefined;
  }
  return (
    <button
      type="button"
      className="workspace-library__file-row"
      data-format={format}
      disabled={!target}
      aria-label={`${target ? "Open" : "Preview"} ${file.title}`}
      aria-description={target ? file.detail : "Original not retained. Reattach to preview."}
      title={file.title + "\n" + file.detail}
      onClick={() => {
        if (target) onOpen(target);
      }}
    >
      <span className="workspace-library__file-icon">
        <Icon size={23} aria-hidden="true" />
      </span>
      <span className="workspace-library__file-detail">
        <strong>{file.title}</strong>
        <small>
          {target ? file.detail : "Original not retained · Reattach to preview"}
        </small>
      </span>
    </button>
  );
}
