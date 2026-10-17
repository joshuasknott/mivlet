/** Parsing only. Execution requires a native check of the exact saved source. */
export function extractGeneratedHtml(text: string) {
  const match = /```mivlet-html\r?\n/.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const end = text.indexOf("```", start);
  const complete = end >= 0;
  const html = text.slice(start, complete ? end : undefined);
  const after = complete ? text.slice(end + 3) : "";
  const error =
    new TextEncoder().encode(html).byteLength > 80_000 ||
    !html.trim() ||
    html.includes("\0") ||
    after.includes("```mivlet-html")
      ? "Use one bounded HTML preview per response."
      : "";
  return { before: text.slice(0, match.index), after, complete, html, error };
}
