/** Provider prompts are independent of response parsing so background execution
 * does not load the conversation renderers or their validation helpers. */
export const GENERATED_UI_INSTRUCTIONS = `Mivlet supports an optional interactive response format: OpenUI. Use Markdown for ordinary answers. When interaction helps, add one fenced openui-v2 block. Local controls update immediately; follow-up buttons stage a reply for review and never grant tool authority. Never request credentials.`;

export async function loadGeneratedUiInstructions() {
  const { default: catalogue } =
    await import("./rich-interface-instructions.json");

  return `${GENERATED_UI_INSTRUCTIONS}\n${catalogue.instructions}\n${GENERATED_HTML_INSTRUCTIONS}`;
}

const GENERATED_HTML_INSTRUCTIONS = `Use OpenUI first for supported interactive responses. For custom simulations, games or bespoke diagrams that OpenUI cannot express, use one fenced mivlet-html block containing a complete, self-contained HTML document (maximum 80,000 UTF-8 bytes). It runs only after the user opens its preview. Inline CSS, SVG and JavaScript are supported inside an isolated guest. No network, CDN, external images, forms, nested frames, workers, downloads, popups, navigation, storage, native APIs or host/tool bridge are available. Never request credentials or send postMessage to the parent. Keep controls accessible, responsive, and respect prefers-reduced-motion. Guest state is temporary and resets when closed; use OpenUI for saved answers. Describe the result briefly outside the fence. Do not combine HTML and OpenUI in one response.`;
