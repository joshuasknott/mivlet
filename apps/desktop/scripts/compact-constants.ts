import { gzipSync } from "node:zlib";
import { minify, type CompressOptions } from "uglify-js";
import ts from "typescript";
import type { Plugin } from "vite";

interface Use {
  start: number;
  end: number;
  kind: "key" | "access" | "optional" | "value";
}
interface Edit extends Use {
  text: string;
}

/** Share repeated string values without renaming a single property or wire key.
 * Computed keys still evaluate to the original string. Only retain a candidate
 * when both its UTF-8 source and gzip are smaller. */
export function compactConstants(code: string): string {
  const source = ts.createSourceFile(
    "chunk.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const identifiers = new Set<string>();
  const uses = new Map<string, Use[]>();
  let directEval = false;
  const add = (key: string, use: Use) => {
    // Literal __proto__ keys have special object-initializer semantics.
    if (key.length < 4 || key === "__proto__") return;
    const list = uses.get(key) ?? [];
    list.push(use);
    uses.set(key, list);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      if (ts.isIdentifier(callee) && callee.text === "eval") directEval = true;
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    )
      add(node.name.text, {
        start: node.name.getStart(source),
        end: node.name.end,
        kind: "key",
      });
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name))
      add(node.name.text, {
        start: node.expression.end,
        end: node.end,
        kind: node.questionDotToken ? "optional" : "access",
      });
    if (ts.isStringLiteral(node)) {
      const parent = node.parent;
      const propertyName =
        ((ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isGetAccessor(parent) ||
          ts.isSetAccessor(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      const address =
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isNamespaceExport(parent) ||
        ts.isExternalModuleReference(parent) ||
        ts.isImportAttribute(parent) ||
        (ts.isCallExpression(parent) &&
          parent.expression.kind === ts.SyntaxKind.ImportKeyword);
      // Preserve directives, module addresses, tagged templates, method names,
      // private fields and all computed names. They are not literal values.
      if (
        !propertyName &&
        !address &&
        !ts.isComputedPropertyName(parent) &&
        !ts.isExpressionStatement(parent)
      )
        add(node.text, {
          start: node.getStart(source),
          end: node.end,
          kind: "value",
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (directEval) return code;

  const declarations: string[] = [];
  const edits: Edit[] = [];
  let serial = 0;
  let best = code;
  let bestBytes = Buffer.byteLength(code);
  let bestGzip = gzipSync(code).byteLength;
  const render = (next: Edit[], declaration: string) => {
    let cursor = 0;
    const parts = ["const " + [...declarations, declaration].join(",") + ";"];
    for (const edit of [...edits, ...next].sort((a, b) => a.start - b.start)) {
      parts.push(code.slice(cursor, edit.start), edit.text);
      cursor = edit.end;
    }
    parts.push(code.slice(cursor));
    return parts.join("");
  };
  const candidates = Array.from(uses)
    .filter(([, list]) => list.length > 1)
    .sort(
      ([a, left], [b, right]) =>
        right.length * (b.length - 3) - left.length * (a.length - 3),
    );
  // Bound build work independently of source size. This is compression, not a
  // security transform; skipped candidates retain their original behavior.
  for (const [key, list] of candidates.slice(0, 500)) {
    let name: string;
    let nextSerial = serial;
    do {
      name = "$" + (nextSerial ? nextSerial.toString(36) : "");
      nextSerial++;
    } while (identifiers.has(name));
    const identifierBoundary = (character: string | undefined) =>
      Boolean(
        character &&
        (/[\w$]/u.test(character) || character.charCodeAt(0) > 127),
      );
    const next = list.map((use) => ({
      ...use,
      // A quote can delimit return"value", case"value" or "value"in object.
      // A new identifier needs explicit separators at those boundaries.
      text:
        use.kind === "value"
          ? (identifierBoundary(code[use.start - 1]) ? " " : "") +
            name +
            (identifierBoundary(code[use.end]) ? " " : "")
          : (use.kind === "optional" ? "?." : "") + "[" + name + "]",
    }));
    const declaration = name + "=" + JSON.stringify(key);
    if (
      next.reduce(
        (total, edit) => total + edit.end - edit.start - edit.text.length,
        0,
      ) <
      declaration.length + 8
    )
      continue;
    const candidate = render(next, declaration);
    const bytes = Buffer.byteLength(candidate);
    if (bytes >= bestBytes) continue;
    const compressed = gzipSync(candidate).byteLength;
    if (compressed > bestGzip) continue;
    best = candidate;
    bestBytes = bytes;
    bestGzip = compressed;
    edits.push(...next);
    declarations.push(declaration);
    identifiers.add(name);
    serial = nextSerial;
  }
  return best;
}

interface ChunkImports {
  imports: readonly string[];
}

/** Validate the emitted syntax and retain a final standard minifier pass only
 * when it also improves both measured encodings. */
export function compactModule(code: string): string {
  const minifyModule = (source: string, compress: CompressOptions) => {
    const result = minify(source, {
      module: true,
      compress,
      mangle: true,
      output: { comments: "some" },
    });
    if (result.error) throw result.error;
    if (!result.code)
      throw new Error("The emitted module could not be minified.");
    return result.code;
  };
  const measure = (source: string) => ({
    raw: Buffer.byteLength(source),
    gzip: gzipSync(source).byteLength,
  });
  const improves = (
    candidate: ReturnType<typeof measure>,
    input: ReturnType<typeof measure>,
  ) => candidate.raw < input.raw && candidate.gzip <= input.gzip;
  const isBetter = (
    candidate: ReturnType<typeof measure>,
    current: ReturnType<typeof measure>,
  ) =>
    candidate.gzip < current.gzip ||
    (candidate.gzip === current.gzip && candidate.raw < current.raw);
  const defaultCompress = { passes: 3 };
  const tunedCompress = { passes: 3, reduce_funcs: false, reduce_vars: false };

  // Keep the original pass exactly: compact constants, then retain the
  // standard minifier only when it improves both measured encodings.
  let best = compactConstants(code);
  let bestSize = measure(best);
  const initial = minifyModule(best, defaultCompress);
  const initialSize = measure(initial);
  if (improves(initialSize, bestSize)) {
    best = initial;
    bestSize = initialSize;
  }

  // A small bounded follow-up can expose constants created by the first pass.
  // Both minifier candidates share one compactConstants result per round.
  for (let round = 0; round < 5; round++) {
    const compact = compactConstants(best);
    const candidates = [
      compact,
      minifyModule(compact, defaultCompress),
      minifyModule(compact, tunedCompress),
    ];
    let selected = best;
    let selectedSize = bestSize;
    for (const candidate of candidates) {
      const candidateSize = measure(candidate);
      if (
        improves(candidateSize, bestSize) &&
        isBetter(candidateSize, selectedSize)
      ) {
        selected = candidate;
        selectedSize = candidateSize;
      }
    }
    if (selected === best) break;
    best = selected;
    bestSize = selectedSize;
  }
  return best;
}

/** Early calls through a static ESM cycle must not acquire new const/TDZ
 * dependencies. Leave every participant in such a cycle unchanged. */
export function hasStaticCycle(
  fileName: string,
  chunks: Readonly<Record<string, ChunkImports>>,
): boolean {
  const seen = new Set<string>();
  const reaches = (name: string): boolean => {
    if (name === fileName) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return chunks[name]?.imports.some(reaches) ?? false;
  };
  return chunks[fileName]?.imports.some(reaches) ?? false;
}

export function shareEmittedConstants(): Plugin {
  return {
    name: "mivlet-share-emitted-constants",
    apply: "build",
    renderChunk: {
      order: "post",
      handler(code, chunk, options, meta) {
        if (
          options.format !== "es" ||
          options.sourcemap ||
          hasStaticCycle(chunk.fileName, meta.chunks)
        )
          return null;
        const compact = compactModule(code);
        return compact === code ? null : { code: compact, map: null };
      },
    },
  };
}
