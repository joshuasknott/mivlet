import type { BuiltinPlugins } from "@fable/protocol";
import computerIcon from "../assets/plugins/computer.png?no-inline";

export interface BuiltinPluginEntry {
  id: "computer";
  name: string;
  description: string;
  icon: string;
  access: string;
  about: string;
}

export const builtinPluginEntries: readonly BuiltinPluginEntry[] = [
  {
    id: "computer",
    name: "Computer Use",
    description: "Use a Windows application with your permission, and work with agent workspace files.",
    icon: computerIcon,
    access: "Supported application controls follow your workspace approval preference. Foreground input needs a separately approved window selection.",
    about: "Computer Use shares your Windows session so an agent can find and operate an existing application. Background actions are the default where the app supports them; screenshots, keys and pixel actions require an explicit foreground selection that can interrupt you, and only some actions work in the background. Disabling Computer Use stops active application control immediately and requires fresh permission before it runs again. This is not a separate desktop and never adds a host shell tool.",
  },
];
export function builtinPluginMentions(plugins?: BuiltinPlugins) {
  return builtinPluginEntries.filter(entry => plugins?.[entry.id]).map(entry => ({ ...entry, status: "enabled" }));
}
export function mentionedBuiltinPlugins(prompt: string) {
  return /(^|\s)@computer(?=$|\s|[.,!?;:])/i.test(prompt) ? [...builtinPluginEntries] : [];
}
/** Selecting a workflow never grants foreground input permission. */
export function builtinPluginInstructions(prompt: string, plugins: BuiltinPlugins | undefined, toolNames: readonly string[]) {
  if (!mentionedBuiltinPlugins(prompt).length) return "";
  if (!plugins) throw new Error("Computer capability information is unavailable. Refresh the Computer panel before using @computer.");
  if (!plugins.computer) throw new Error("Enable Computer Use in Plugins before using @computer.");
  if (!toolNames.includes("local-app-observe")) throw new Error("Computer Use is unavailable on this executing model route.");
  return "The user selected @computer. Find the application with local-app-list and select its exact window with local-app-select. Follow the existing global approval policy; Full Access needs no separate app grant. Ask about the target only when it is genuinely ambiguous. Verify effects and publish workspace outputs with computer-artifact.";
}
