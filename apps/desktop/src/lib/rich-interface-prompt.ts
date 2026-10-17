/** Keep component signatures generated from the real catalogue while replacing
 * upstream instructions for features outside Mivlet's deliberately bounded AST. */
export function buildRichInterfaceInstructions(upstream: string): string {
  const catalogue = upstream.split("## Component Signatures\n")[1]?.split("## Built-in Functions")[0];
  const signatures = catalogue?.split("\n").filter((line) => /^[A-Z][A-Za-z]+\(/.test(line));
  if (!signatures?.length) throw new Error("The OpenUI component catalogue is unavailable.");
  return `Mivlet renders optional interactive answers using its bounded OpenUI profile.
Use ordinary Markdown for ordinary answers. When interaction adds value, include exactly one fenced openui-v2 block. Brief explanatory Markdown may appear outside the fence. Never emit an unfenced OpenUI program or combine OpenUI with mivlet-html.

Syntax:
- Each statement is identifier = expression on its own line. Define root = Stack([...]) first; references may be defined later.
- Arguments are positional, never named. Components may be inline or referenced by another statement.
- Literals: double-quoted strings with JSON escaping, finite numbers, true, false, null, arrays and objects.
- Declare mutable scalar state with $name = literal. Bind inputs to the same $name. Define every reference.
- Supported expressions: + - * / %, comparisons == != > < >= <=, && || !, and condition ? yes : no. Use parentheses for grouping.
- Supported data functions only: @Count, @First, @Last, @Sum, @Avg, @Min, @Max, @Round(number, decimals), @Abs, @Floor, @Ceil. Pass literal arrays or references to arrays; object member and index access are unavailable.
- Button actions: @Set($name, value), @Reset($name), @ToAssistant("Follow-up for the user to review"). Combine steps with Action([steps]). A button without an action stages its label. Follow-ups never send automatically or grant permission.
- No queries, mutations, loops, URL actions, HTML, JavaScript, tools, credentials or network access. Do not invent components or functions.
- Limits: 48,000 characters, 128 statements, depth 12, 2,048 nodes, 100 values per array. Keep saved state below 8,000 UTF-8 bytes and string values below 2,000 characters.
- Photo requires an exact published image artifact id returned by a tool. If none exists, use text. Never invent image sources.

Component signatures (arguments are positional; optional arguments may be omitted from the end; $binding means a declared $variable):
${signatures.join("\n")}

Complete example:
\`\`\`openui-v2
root = Stack([people, total, followup])
$people = 4
people = Input("people", "People", $people, "number")
total = TextContent($people > 0 ? "Each person pays £" + @Round(80 / $people, 2) : "Choose at least one person")
followup = Button("Refine this plan", @ToAssistant("Refine this plan using my saved answers"))
\`\`\`
Verify that every reference resolves, all content is reachable from root, all bindings use declared state, and computed values use expressions rather than fixed answers.`;
}
