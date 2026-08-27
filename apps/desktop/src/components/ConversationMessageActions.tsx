import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Books } from "@phosphor-icons/react/dist/csr/Books";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { GraduationCap } from "@phosphor-icons/react/dist/csr/GraduationCap";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";

type MessageRole = "user" | "assistant";

async function copyText(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = content;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Copy is unavailable.");
}

export function ConversationMessageActions({
  role,
  content,
  onSaveToKnowledge,
  onMakeRoutine,
  onTeachTask,
  onEdit,
  onRedo,
  redoDisabled = false,
}: {
  role: MessageRole;
  content: string;
  onSaveToKnowledge: () => Promise<void>;
  onMakeRoutine?: () => void;
  onTeachTask?: () => void;
  onEdit?: () => void;
  onRedo?: () => void;
  redoDisabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  const runSave = async () => {
    setSaving(true);
    setStatus("");
    try {
      await onSaveToKnowledge();
      setStatus("Saved to Knowledge");
    } catch {
      setStatus("Could not save to Knowledge");
    } finally {
      setSaving(false);
    }
  };

  const runCopy = async () => {
    setStatus("");
    try {
      await copyText(content);
      setStatus(role === "user" ? "Prompt copied" : "Response copied");
    } catch {
      setStatus("Could not copy");
    }
  };

  const action = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      className="conversation-message-action"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  return (
    <div
      className={`conversation-message-actions conversation-message-actions--${role}`}
      role="group"
      aria-label={`${role === "user" ? "User" : "Assistant"} message actions`}
    >
      {action(
        saving ? "Saving to Knowledge" : "Save to Knowledge",
        <Books size={16} aria-hidden="true" />,
        () => {
          void runSave();
        },
        saving,
      )}
      {action(
        role === "user" ? "Copy prompt" : "Copy response",
        <Copy size={16} aria-hidden="true" />,
        () => {
          void runCopy();
        },
      )}
      {onMakeRoutine
        ? action(
            "Make routine",
            <Clock size={16} aria-hidden="true" />,
            onMakeRoutine,
          )
        : null}
      {role === "assistant" && onTeachTask
        ? action(
            "Teach this",
            <GraduationCap size={16} aria-hidden="true" />,
            onTeachTask,
          )
        : null}
      {role === "user" && onEdit
        ? action(
            "Edit prompt",
            <PencilSimple size={16} aria-hidden="true" />,
            onEdit,
          )
        : null}
      {role === "assistant" && onRedo
        ? action(
            "Redo response",
            <ArrowClockwise size={16} aria-hidden="true" />,
            onRedo,
            redoDisabled,
          )
        : null}
      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
