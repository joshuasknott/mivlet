export interface DictationInsertion {
  value: string;
  caret: number;
}

/**
 * Insert a final transcript at the current selection without replacing any
 * text outside that selection. Boundary spaces are added only where needed.
 */
export function insertDictation(
  value: string,
  transcript: string,
  selectionStart = value.length,
  selectionEnd = selectionStart
): DictationInsertion {
  const normalized = transcript.trim();
  if (!normalized) return { value, caret: selectionStart };

  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing =
    after.length > 0 && !/^\s/.test(after) && !/^[,.;:!?)}\]]/.test(after)
      ? " "
      : "";
  const inserted = `${leading}${normalized}${trailing}`;

  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length
  };
}
