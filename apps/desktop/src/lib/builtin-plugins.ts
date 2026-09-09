import type { BuiltinPlugins } from "@fable/protocol";
import browserIcon from "../assets/plugins/browser.png?no-inline";
import computerIcon from "../assets/plugins/computer.png?no-inline";

export const builtinPluginEntries = [
  { id: "browser", name: "Browser", description: "Read websites and use tabs in your agent's browser.", icon: browserIcon },
  { id: "computer", name: "Computer Use", description: "Use desktop apps, terminal and files in your agent's computer.", icon: computerIcon },
] as const;

export function builtinPluginMentions(plugins?: BuiltinPlugins) {
  return builtinPluginEntries.filter((entry) => plugins?.[entry.id]).map((entry) => ({ ...entry, status: "enabled" }));
}

export function mentionedBuiltinPlugins(prompt: string) {
  const ids = new Set([...prompt.matchAll(/(^|\s)@(browser|computer)(?=$|\s|[.,!?;:])/gi)].map((match) => match[2].toLowerCase()));
  return builtinPluginEntries.filter((entry) => ids.has(entry.id));
}

/** Mentions select a workflow, never grant permission or return human control. */
export function builtinPluginInstructions(prompt: string, plugins: BuiltinPlugins | undefined, toolNames: readonly string[]) {
  return mentionedBuiltinPlugins(prompt).map((entry) => {
    if (!plugins?.[entry.id]) throw new Error(`Enable ${entry.name} in Plugins → Featured before using @${entry.id}.`);
    const required = entry.id === "browser" ? "local-browser-observe" : "run-shell";
    if (!toolNames.includes(required)) throw new Error(`${entry.name} is unavailable. Start the agent's computer and return control to the agent before using @${entry.id}.`);
    return entry.id === "browser"
      ? "The user selected @browser. Use the Browser plugin's local-browser tools for this request, starting with a fresh structured observation or tab listing. Verify results and publish requested downloads with computer-artifact. This mention grants no additional permissions."
      : `The user selected @computer. Use the Computer Use plugin's isolated computer tools for this request. Verify work and publish outputs with computer-artifact. This mention grants no additional permissions.${toolNames.includes("local-desktop-observe") ? " Observe the desktop before visual actions." : " Visual desktop control is unavailable on this model route; explain this if required. File and terminal tools remain available."}`;
  }).join("\n\n");
}
