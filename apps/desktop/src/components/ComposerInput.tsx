import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { mentionParts, type MentionConnector } from "./ConnectorMention";
import { connectorLogos } from "./marketplace/connector-logos";

export interface ComposerInputHandle {
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

function plainText(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.mention)
    return node.dataset.mention;
  if (node.nodeName === "BR") return "\n";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  return Array.from(node.childNodes)
    .map(
      (child, index) =>
        `${index > 0 && child.nodeName === "DIV" ? "\n" : ""}${plainText(child)}`,
    )
    .join("");
}

function selectionOffsets(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode))
    return [plainText(element).length, plainText(element).length];
  const selected = selection.getRangeAt(0);
  const before = selected.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(selected.startContainer, selected.startOffset);
  const start = plainText(before.cloneContents()).length;
  return [start, start + plainText(selected.cloneContents()).length];
}

function setSelection(element: HTMLElement, start: number, end: number) {
  const position = (offset: number): [Node, number] => {
    for (const child of element.childNodes) {
      const length = plainText(child).length;
      if (offset <= length) {
        if (child.nodeType === Node.TEXT_NODE) return [child, offset];
        return [
          element,
          Array.from(element.childNodes).indexOf(child as ChildNode) +
            (offset > 0 ? 1 : 0),
        ];
      }
      offset -= length;
    }
    return [element, element.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...position(start));
  range.setEnd(...position(end));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

export function ComposerInput({
  inputRef,
  value,
  onChange,
  onKeyDown,
  placeholder,
  connectors,
}: {
  inputRef: RefObject<ComposerInputHandle | null>;
  value: string;
  onChange(value: string): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  placeholder: string;
  connectors: readonly MentionConnector[];
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  useImperativeHandle(
    inputRef,
    () => ({
      focus: () => elementRef.current?.focus(),
      setSelectionRange: (start, end) => {
        if (elementRef.current) setSelection(elementRef.current, start, end);
      },
      get selectionStart() {
        return elementRef.current ? selectionOffsets(elementRef.current)[0] : 0;
      },
      get selectionEnd() {
        return elementRef.current ? selectionOffsets(elementRef.current)[1] : 0;
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element || composing.current) return;
    const parts = mentionParts(value, connectors);
    const mentions = parts.filter((part) => part.connector).length;
    if (
      plainText(element) === value &&
      element.querySelectorAll("[data-mention]").length === mentions
    )
      return;
    const focused = document.activeElement === element;
    const [start, end] = selectionOffsets(element);
    element.replaceChildren();
    for (const part of parts) {
      if (!part.connector) {
        if (part.text) element.append(document.createTextNode(part.text));
        continue;
      }
      const chip = document.createElement("span");
      chip.className = "connector-mention";
      chip.dataset.mention = part.text;
      chip.setAttribute("contenteditable", "false");
      const logo = connectorLogos[part.connector.id];
      if (logo) {
        const icon = document.createElement("img");
        icon.src = logo;
        icon.alt = "";
        chip.append(icon);
      }
      chip.append(document.createTextNode(part.connector.name));
      element.append(chip);
    }
    if (focused)
      setSelection(
        element,
        Math.min(start, value.length),
        Math.min(end, value.length),
      );
  }, [value, connectors]);
  return (
    <div
      ref={elementRef}
      className="composer-input"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Universal composer"
      data-placeholder={placeholder}
      onInput={(event) => {
        if (!composing.current) onChange(plainText(event.currentTarget));
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onChange(plainText(event.currentTarget));
      }}
      onKeyDown={onKeyDown}
      onPaste={(event) => {
        event.preventDefault();
        document.execCommand(
          "insertText",
          false,
          event.clipboardData.getData("text/plain"),
        );
      }}
      onCopy={(event) => {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        event.preventDefault();
        event.clipboardData.setData(
          "text/plain",
          plainText(selection.getRangeAt(0).cloneContents()),
        );
      }}
    />
  );
}
