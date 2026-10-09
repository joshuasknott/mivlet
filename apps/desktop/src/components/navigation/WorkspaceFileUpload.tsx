import { useRef, useState } from "react";
import type { ConversationRoom } from "@mivlet/protocol";
import { UploadSimple } from "@phosphor-icons/react/dist/csr/UploadSimple";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { useScopedComposer } from "../../hooks/useScopedComposer";
import { prepareComposerImage } from "../../lib/composer-images";
import { prepareReadableComposerAttachment } from "../../lib/composer-attachments";

/** Add to the exact conversation draft, never send or widen file access. */
export function WorkspaceFileUpload({
  room,
  runtime,
}: {
  room: ConversationRoom;
  runtime: ShellRuntime;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const owner = runtime.accountWorkspaceStatus.activeContextOwner;
  const composer = useScopedComposer({
    workspaceId: room.workspaceId,
    accountId: `${owner?.internalUserId}:${owner?.memberId ?? ""}`,
    agentId: room.facilitatorId ?? "unavailable",
    projectId: room.projectId,
    threadId: room.id,
  });
  return (
    <div className="workspace-library__upload">
      <button
        type="button"
        aria-label="Add files to chat"
        disabled={
          pending ||
          !composer.ready ||
          composer.submitting ||
          composer.attachments.length >= 12
        }
        onClick={() => input.current?.click()}
      >
        <UploadSimple size={20} aria-hidden="true" />
        Add
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.csv,.yaml,.yml"
        onChange={async (event) => {
          const files = Array.from(event.target.files ?? []).slice(
            0,
            Math.max(0, 12 - composer.attachments.length),
          );
          event.target.value = "";
          if (!files.length) return;
          setPending(true);
          setStatus("");
          try {
            for (const file of files) {
              const id = `attachment-${crypto.randomUUID()}`;
              const prepared = file.type.startsWith("image/")
                ? await prepareComposerImage(file, id).then((imageInput) => ({
                    imageInput,
                    previewUrl: imageInput.dataUrl,
                    status: "Image input · transient",
                  }))
                : await prepareReadableComposerAttachment(
                    file,
                    runtime.importKnowledgeFile,
                  );
              if (
                !("imageInput" in prepared) &&
                !("transientBytes" in prepared && prepared.transientBytes)
              )
                throw new Error(`${file.name}: ${prepared.status}`);
              composer.setAttachments((current) =>
                current.length >= 12
                  ? current
                  : [
                      ...current,
                      {
                        id,
                        name: file.name,
                        type: file.type || "application/octet-stream",
                        sizeBytes: file.size,
                        ...prepared,
                      },
                    ],
              );
            }
            setStatus(
              "Added to the chat draft. Review attachments before sending.",
            );
          } catch (error) {
            setStatus(
              error instanceof Error
                ? error.message
                : "Could not prepare files.",
            );
          } finally {
            setPending(false);
          }
        }}
      />
      {status && <p role="status">{status}</p>}
    </div>
  );
}
