import type { GeneratedInterfaceCapability } from "@mivlet/protocol";

const capability: GeneratedInterfaceCapability = {
  format: "openui",
  catalogue: "mivlet-v2",
  actions: "review-in-composer",
  maxCharacters: 48000,
  automaticToolCalls: false,
};
/** Mivlet's deliberately small OpenUI language profile. No expressions, queries,
 * mutations, URLs or executable source reach the OpenUI interpreter. */
const GENERATED_UI_LIMITS = {
  characters: capability.maxCharacters,
  statements: 128,
  depth: 12,
  nodes: 2048,
} as const;
const components = new Set([
  "Stack",
  "Text",
  "Comparison",
  "Options",
  "Form",
  "Table",
  "Chart",
  "Plan",
  "Draft",
]);
type Value =
  string | number | boolean | null | Value[] | { [key: string]: Value };
type Expression = { name: string; args: Value[]; refs: string[] };

/** Newlines inside literal arrays/objects are formatting, not new statements.
 * Keep newlines inside strings intact so JSON validation still rejects them. */
function interfaceStatements(code: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (const character of code) {
    if (quoted) {
      current += character;
      if (!escaped && character === '"') quoted = false;
      escaped = !escaped && character === "\\";
      continue;
    }
    if (character === '"') quoted = true;
    else if ("([{".includes(character)) depth++;
    else if (")]}".includes(character)) depth--;
    if (character === "\n" && depth <= 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else
      current += character === "\n" || character === "\r" ? " " : character;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function extractGeneratedInterface(text: string) {
  const opening = /^ {0,3}```openui(-v2)?[\t ]*\r?\n/im.exec(text);
  if (!opening) {
    // Older provider prompts required a raw program. Recover that envelope
    // without evaluating ordinary prose or guessing a missing root.
    const code = text.trim();
    if (/^\$?[a-zA-Z][a-zA-Z0-9_]*\s*=/.test(code) && /^root\s*=/m.test(code) && !code.includes("```"))
      return { profile: "mivlet-v2" as const, before: "", code, after: "", complete: true };
    return null;
  }
  const start = opening.index;
  const contentStart = start + opening[0].length;
  const closing = /^ {0,3}```[\t ]*(?=\r?$)/m.exec(text.slice(contentStart));
  const end = closing ? contentStart + closing.index : -1;
  const code = text.slice(contentStart, end < 0 ? undefined : end);
  const rich = Boolean(opening[1]) || /^\s*\$[a-zA-Z]/m.test(code) || /\b(?:TextContent|Card|Input|Slider|Choice|Photo|Tabs|TabItem|BarChart|LineChart|Button)\(/.test(code);
  return {
    ...(rich ? { profile: "mivlet-v2" as const } : {}),
    before: text.slice(0, start),
    code,
    after: end < 0 ? "" : text.slice(end + closing![0].length),
    complete: end >= 0,
  };
}

/** Validate before invoking a library parser, bounding even malformed input. */
export function validateGeneratedInterface(
  code: string,
  streaming = false,
  profile?: "mivlet-v2",
): { code: string; error?: string } {
  if (code.length > GENERATED_UI_LIMITS.characters)
    return {
      code: "",
      error: "This interface exceeds the 48,000 character limit.",
    };
  // V2 is parsed and validated by OpenUI's AST guard inside the lazy renderer.
  // This cheap bound keeps the rich engine outside ordinary chat/startup.
  if (profile === "mivlet-v2") return { code };
  try {
    const lines = interfaceStatements(code);
    if (lines.length > GENERATED_UI_LIMITS.statements)
      throw new Error("Too many interface components.");
    const definitions = new Map<string, Expression>();
    const accepted: string[] = [];
    let tokens = 0;
    for (const [index, line] of lines.entries()) {
      const match = /^([a-z][a-zA-Z0-9_]{0,63})\s*=\s*([A-Z][A-Za-z]+)\(/.exec(
        line.trim(),
      );
      if (!match) {
        if (streaming && index === lines.length - 1) break;
        throw new Error(
          "Only approved OpenUI component statements are supported.",
        );
      }
      if (!components.has(match[2]) || definitions.has(match[1]))
        throw new Error("Unknown or duplicate interface component.");
      const source = line.trim();
      let offset = match[0].length;
      const refs: string[] = [];
      const whitespace = () => {
        while (/\s/.test(source[offset] ?? "") && offset < source.length)
          offset++;
      };
      const value = (depth: number): Value => {
        if (
          ++tokens > GENERATED_UI_LIMITS.nodes ||
          depth > GENERATED_UI_LIMITS.depth
        )
          throw new Error("Interface nesting or resource limit exceeded.");
        whitespace();
        const ch = source[offset];
        if (ch === '"') {
          const begin = offset++;
          let escaped = false;
          while (offset < source.length) {
            const next = source[offset++];
            if (!escaped && next === '"')
              return JSON.parse(source.slice(begin, offset)) as string;
            escaped = !escaped && next === "\\";
          }
          throw new Error("Incomplete string.");
        }
        if (ch === "[") {
          offset++;
          const items: Value[] = [];
          whitespace();
          if (source[offset] === "]") {
            offset++;
            return items;
          }
          while (offset < source.length) {
            items.push(value(depth + 1));
            whitespace();
            if (source[offset++] === "]") return items;
            if (source[offset - 1] !== ",") throw new Error("Invalid array.");
          }
          throw new Error("Incomplete array.");
        }
        if (ch === "{") {
          offset++;
          const object: Record<string, Value> = Object.create(null) as Record<
            string,
            Value
          >;
          whitespace();
          if (source[offset] === "}") {
            offset++;
            return object;
          }
          while (offset < source.length) {
            whitespace();
            if (source[offset] !== '"')
              throw new Error("Object keys must be quoted.");
            const key = value(depth + 1);
            if (
              typeof key !== "string" ||
              ["__proto__", "constructor", "prototype"].includes(key)
            )
              throw new Error("Invalid property.");
            whitespace();
            if (source[offset++] !== ":") throw new Error("Invalid object.");
            object[key] = value(depth + 1);
            whitespace();
            if (source[offset++] === "}") return object;
            if (source[offset - 1] !== ",") throw new Error("Invalid object.");
          }
          throw new Error("Incomplete object.");
        }
        const literal =
          /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?)(?=[,\]\s})])/.exec(
            source.slice(offset),
          );
        if (literal) {
          offset += literal[0].length;
          return JSON.parse(literal[0]) as Value;
        }
        const ref = /^[a-z][a-zA-Z0-9_]{0,63}(?=[,\]\s})])/.exec(
          source.slice(offset),
        );
        if (ref) {
          offset += ref[0].length;
          refs.push(ref[0]);
          return null;
        }
        throw new Error(
          "Expressions and automatic tool calls are not allowed.",
        );
      };
      const args: Value[] = [];
      try {
        whitespace();
        if (source[offset] !== ")")
          while (offset < source.length) {
            args.push(value(0));
            whitespace();
            if (source[offset] === ")") break;
            if (source[offset++] !== ",")
              throw new Error("Invalid component arguments.");
          }
        if (source[offset++] !== ")" || source.slice(offset).trim())
          throw new Error("Incomplete or invalid component.");
      } catch (error) {
        if (
          streaming &&
          index === lines.length - 1 &&
          /Incomplete/.test(String(error))
        )
          break;
        throw error;
      }
      // Only Stack accepts references. Other components contain plain bounded data.
      if (refs.length && match[2] !== "Stack")
        throw new Error("Only Stack may reference other components.");
      definitions.set(match[1], { name: match[2], args, refs });
      accepted.push(source);
    }
    // A sole named display component is unambiguous. Canonicalize its name;
    // never infer a root for multiple disconnected statements.
    if (!streaming && !definitions.has("root") && definitions.size === 1) {
      const [id, expression] = definitions.entries().next().value!;
      if (!expression.refs.length) {
        definitions.delete(id);
        definitions.set("root", expression);
        accepted[0] = accepted[0].replace(/^[a-z][a-zA-Z0-9_]{0,63}/, "root");
      }
    }
    if (!definitions.has("root")) {
      if (streaming) return { code: "" };
      throw new Error("The interface is missing its root.");
    }
    let expanded = 0;
    const visit = (id: string, path: Set<string>) => {
      if (
        ++expanded > GENERATED_UI_LIMITS.nodes ||
        path.size > GENERATED_UI_LIMITS.depth ||
        path.has(id)
      )
        throw new Error(
          "Interface reference cycle or resource limit exceeded.",
        );
      const expression = definitions.get(id);
      if (!expression) {
        if (streaming) return;
        throw new Error("The interface contains an unresolved component.");
      }
      for (const ref of expression.refs) visit(ref, new Set([...path, id]));
    };
    visit("root", new Set());
    return { code: accepted.join("\n") };
  } catch (error) {
    return {
      code: "",
      error:
        error instanceof Error ? error.message : "Invalid generated interface.",
    };
  }
}

export const GENERATED_UI_INSTRUCTIONS = `Mivlet supports an optional interactive response format: OpenUI. Use Markdown for ordinary answers. When interaction helps, add one fenced openui-v2 block. Local controls update immediately; follow-up buttons stage a reply for review and never grant tool authority. Never request credentials.`;

export async function loadGeneratedUiInstructions() {
  const { default: catalogue } =
    await import("./rich-interface-instructions.json");
  const { GENERATED_HTML_INSTRUCTIONS } = await import("./generated-html");
  return `${GENERATED_UI_INSTRUCTIONS}\n${catalogue.instructions}\n${GENERATED_HTML_INSTRUCTIONS}`;
}
