import { useState } from "react";
import type { MemoryRecord } from "@mivlet/protocol";
import { SlidersHorizontal } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { Flag } from "@phosphor-icons/react/dist/csr/Flag";
import { NotePencil } from "@phosphor-icons/react/dist/csr/NotePencil";
import { Lightbulb } from "@phosphor-icons/react/dist/csr/Lightbulb";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";

const kinds = {
  preference: { label: "Preference", icon: SlidersHorizontal },
  decision: { label: "Decision", icon: Flag },
  fact: { label: "Fact", icon: NotePencil },
  inference: { label: "Inference", icon: Lightbulb },
  correction: { label: "Correction", icon: NotePencil },
  imported: { label: "Imported", icon: NotePencil },
};

export function MemoryRecordCard({
  record,
  group,
  pending,
  onEdit,
  onToggle,
  onDelete,
  onApprove,
  onOpenSource,
}: {
  record: MemoryRecord;
  group: string;
  pending: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onApprove: () => void;
  onOpenSource?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const suggested = record.approvalState === "suggested";
  const kind = kinds[record.kind] ?? kinds.fact;
  const Icon = suggested ? Sparkle : kind.icon;
  const long = record.value.length > 180 || record.value.split("\n").length > 3;
  return (
    <article
      className={
        "workspace-memories__record" +
        (suggested ? " workspace-memories__record--suggested" : "")
      }
      data-kind={record.kind}
    >
      <Icon
        className="workspace-memories__kind-icon"
        size={20}
        aria-hidden="true"
      />
      <div className="workspace-memories__record-content">
        <div className="workspace-memories__record-heading">
          <strong>{record.title}</strong>
          <span className="workspace-memories__kind">
            {suggested ? "Suggested" : kind.label}
          </span>
          {!suggested && (
            <details
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                  event.stopPropagation();
                }
              }}
            >
              <summary aria-label={`Actions for ${record.title}`}>
                <DotsThree size={20} aria-hidden="true" />
              </summary>
              <div className="workspace-memories__actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    onEdit();
                  }}
                >
                  Edit
                </button>
                <button type="button" disabled={pending} onClick={onToggle}>
                  {record.disabled ? "Enable" : "Disable"}
                </button>
                <button type="button" disabled={pending} onClick={onDelete}>
                  Delete
                </button>
              </div>
            </details>
          )}
        </div>
        <p className="workspace-memories__value" data-expanded={expanded}>
          {record.value}
        </p>
        {long && (
          <button
            type="button"
            className="workspace-memories__read-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Read more"}
          </button>
        )}
        <div className="workspace-memories__metadata">
          <small className="workspace-memories__source">
            {record.source || group}
            {record.disabled ? " · Disabled" : ""}
          </small>
          {onOpenSource ? (
            <button
              type="button"
              className="workspace-memories__source-link"
              onClick={onOpenSource}
            >
              View source <ArrowSquareOut size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {!onOpenSource && record.provenance?.note ? (
          <details className="workspace-memories__provenance">
            <summary>Source details</summary>
            <p>{record.provenance.note}</p>
          </details>
        ) : null}
        {suggested && (
          <div className="workspace-memories__suggestion-actions">
            <button type="button" disabled={pending} onClick={onApprove}>
              Save
            </button>
            <button type="button" disabled={pending} onClick={onDelete}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
