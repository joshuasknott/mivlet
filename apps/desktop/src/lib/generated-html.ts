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
    html.length > 80_000 ||
    html.includes("\0") ||
    after.includes("```mivlet-html")
      ? "Use one bounded HTML preview per response."
      : "";
  return { before: text.slice(0, match.index), after, complete, html, error };
}

export const GENERATED_HTML_INSTRUCTIONS = `Use OpenUI first for supported interactive responses. For custom simulations, games or bespoke diagrams that OpenUI cannot express, use one fenced mivlet-html block containing a complete, self-contained HTML document (maximum 80,000 characters). It runs only after the user opens its preview. Inline CSS, SVG and JavaScript are supported inside an isolated guest. No network, CDN, external images, forms, nested frames, workers, downloads, popups, navigation, storage, native APIs or host/tool bridge are available. Never request credentials or send postMessage to the parent. Keep controls accessible, responsive, and respect prefers-reduced-motion. Guest state is temporary and resets when closed; use OpenUI for saved answers. Describe the result briefly outside the fence. Do not combine HTML and OpenUI in one response.`;
