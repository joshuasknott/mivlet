/** Map a rendered Markdown selection back to an exact bounded source passage.
 * Only presentation punctuation and whitespace are normalized. The returned
 * value is always a literal slice of the source, which native authority checks
 * against the saved revision again before any contextual action is accepted.
 */
export function selectedSourcePassage(source: string, selection: string): string {
  const selected = selection.trim();
  if (!selected || selected.length > 8000 || source.length > 120000) return "";
  if (source.includes(selected)) return selected;
  const project = (text: string) => {
    let value = "";
    const positions: number[] = [];
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (/[`*_#>\[\]|]/.test(char)) continue;
      if (/\s/.test(char)) {
        if (!value || value.endsWith(" ")) continue;
        value += " ";
      } else value += char;
      positions.push(index);
    }
    return { value: value.trimEnd(), positions };
  };
  const needle = project(selected).value;
  if (!needle) return "";
  const haystack = project(source);
  const at = haystack.value.indexOf(needle);
  if (at < 0) return "";
  let start = haystack.positions[at]!;
  let end = haystack.positions[at + needle.length - 1]! + 1;
  // Include adjacent emphasis/code delimiters so the quoted source remains
  // readable when the selection begins or ends inside an inline element.
  while (start > 0 && /[`*_]/.test(source[start - 1]!)) start--;
  while (end < source.length && /[`*_]/.test(source[end]!)) end++;
  const passage = source.slice(start, end);
  return passage.length <= 8000 ? passage : "";
}
