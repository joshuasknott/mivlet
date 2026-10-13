import {
  autoClose,
  parseExpression,
  split,
  tokenize,
  type ASTNode,
} from "@openuidev/lang-core";

const math = new Set([
  "Count",
  "Sum",
  "Avg",
  "Min",
  "Max",
  "First",
  "Last",
  "Round",
  "Abs",
  "Floor",
  "Ceil",
  "Set",
  "Reset",
  "ToAssistant",
]);
const forbiddenKey = (key: string) =>
  ["__proto__", "prototype", "constructor"].includes(key);

/** Inspect upstream ASTs before giving any source to the interpreter. */
export function validateRichInterface(
  code: string,
  components: ReadonlySet<string>,
  streaming = false,
) {
  try {
    if (code.length > 48000)
      throw new Error("This interface exceeds its size limit.");
    // Bound malformed input before recursive parsing, including operator chains.
    let depth = 0,
      quoted = false,
      escaped = false,
      punctuation = 0;
    for (const char of code) {
      if (quoted) {
        if (!escaped && char === '"') quoted = false;
        escaped = !escaped && char === "\\";
        continue;
      }
      if (char === '"') quoted = true;
      else {
        if ("([{".includes(char) && ++depth > 12)
          throw new Error("Interface nesting limit exceeded.");
        if (")]}".includes(char) && --depth < 0)
          throw new Error("Unbalanced interface source.");
        if (";`\\".includes(char))
          throw new Error("Executable source is not supported.");
        if (",+-*/%?:".includes(char) && ++punctuation > 2048)
          throw new Error("Interface resource limit exceeded.");
      }
    }
    if (!streaming && (depth || quoted || autoClose(code).wasIncomplete))
      throw new Error("Incomplete interface.");
    const statements = split(tokenize(streaming ? autoClose(code).text : code));
    if (statements.length > 128)
      throw new Error("Too many interface statements.");
    const definitions = new Map<string, ASTNode>();
    const links = new Map<string, string[]>();
    let nodes = 0;
    const visit = (node: ASTNode, refs: string[], level: number) => {
      if (++nodes > 2048 || level > 12)
        throw new Error("Interface resource limit exceeded.");
      const next = (child: ASTNode) => visit(child, refs, level + 1);
      switch (node.k) {
        case "Comp":
          if (!(
            components.has(node.name) ||
            node.name === "Action" ||
            math.has(node.name)
          ))
            throw new Error(`Unsupported component or function: ${node.name}`);
          node.args.forEach(next);
          break;
        case "Ref":
        case "StateRef":
        case "Ph":
          refs.push(node.n);
          break;
        case "Arr":
          if (node.els.length > 100) throw new Error("Too many array values.");
          node.els.forEach(next);
          break;
        case "Obj":
          node.entries.forEach(([key, value]) => {
            if (forbiddenKey(key)) throw new Error("Invalid property.");
            next(value);
          });
          break;
        case "BinOp":
          next(node.left);
          next(node.right);
          break;
        case "UnaryOp":
          next(node.operand);
          break;
        case "Ternary":
          next(node.cond);
          next(node.then);
          next(node.else);
          break;
        case "Num":
          if (!Number.isFinite(node.v) || Math.abs(node.v) > 1e12)
            throw new Error("Invalid number.");
          break;
        case "Str":
          if (node.v.length > 16000) throw new Error("Text limit exceeded.");
          break;
        case "Bool":
        case "Null":
          break;
        default:
          throw new Error(
            "Tool calls, member access and assignments are not supported.",
          );
      }
    };
    for (const statement of statements) {
      if (
        !/^\$?[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(statement.id) ||
        definitions.has(statement.id)
      )
        throw new Error("Invalid or duplicate statement.");
      const node = parseExpression(statement.tokens);
      const refs: string[] = [];
      visit(node, refs, 0);
      if (
        statement.id.startsWith("$") &&
        !["Str", "Num", "Bool", "Arr", "Obj", "Null"].includes(node.k)
      )
        throw new Error("State defaults must be literal values.");
      definitions.set(statement.id, node);
      links.set(statement.id, refs);
    }
    let expanded = 0;
    const walk = (id: string, path: Set<string>) => {
      if (++expanded > 2048 || path.size > 12 || path.has(id))
        throw new Error("Interface cycle or resource limit exceeded.");
      if (!definitions.has(id)) {
        if (streaming) return;
        throw new Error(`Unresolved interface reference: ${id}`);
      }
      for (const ref of links.get(id) ?? []) walk(ref, new Set([...path, id]));
    };
    if (!definitions.has("root")) {
      if (streaming) return { code: "" };
      throw new Error("The interface is missing its root.");
    }
    // Validate disconnected definitions too: they must not hide unsafe calls.
    for (const id of definitions.keys()) walk(id, new Set());
    return { code };
  } catch (error) {
    return {
      code: "",
      error: error instanceof Error ? error.message : "Invalid interface.",
    };
  }
}

/** Opaque upstream state travels through the existing bounded native string
 * field. The native boundary still rejects credentials and stale revisions. */
export function encodeRichState(state: Record<string, unknown>): string {
  let nodes = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (++nodes > 256 || depth > 6)
      throw new Error("Interface state limit exceeded.");
    if (value === null || typeof value === "boolean") return;
    if (
      typeof value === "string" &&
      value.length <= 2000 &&
      !value.includes("\0")
    )
      return;
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= 1e12
    )
      return;
    if (Array.isArray(value) && value.length <= 96) {
      value.forEach((item) => inspect(item, depth + 1));
      return;
    }
    if (
      value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).length <= 96
    ) {
      Object.entries(value).forEach(([key, item]) => {
        if (forbiddenKey(key) || key.length > 128)
          throw new Error("Invalid state key.");
        inspect(item, depth + 1);
      });
      return;
    }
    throw new Error("Unsupported interface state.");
  };
  inspect(state, 0);
  const encoded = JSON.stringify(state);
  if (encoded.length > 8000)
    throw new Error("Interface state exceeds its storage limit.");
  return encoded;
}

export function decodeRichState(encoded?: string): Record<string, unknown> {
  if (!encoded) return {};
  const value: unknown = JSON.parse(encoded);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid saved interface state.");
  encodeRichState(value as Record<string, unknown>);
  return value as Record<string, unknown>;
}
