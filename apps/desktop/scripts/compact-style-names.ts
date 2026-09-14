import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";

interface Source {
  fileName: string;
  code: string;
}
function safeModifier(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (ts.isStringLiteralLike(node))
    return node.text === "" || /^(--|\s)/.test(node.text);
  return (
    ts.isConditionalExpression(node) &&
    safeModifier(node.whenTrue) &&
    safeModifier(node.whenFalse)
  );
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Compact only CSS names whose source uses are exclusively class attributes.
 * Protocol values, imports, opaque helper strings and dynamic class prefixes
 * remain unchanged. Modifiers are retained so conditional templates still work. */
export function styleNameMap(
  css: string,
  sources: Source[] = [],
): Map<string, string> {
  if (/\._[0-9a-z]+(?=[\s.:#>{])|--_[0-9a-z]+\s*:/.test(css))
    throw new Error("Reserved compact style prefix already exists.");
  const candidates = new Set(
    Array.from(
      css.matchAll(/\.([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*)/g),
      (match) => match[1],
    ).filter((name) => name.includes("-") || name.includes("__")),
  );
  const seen = new Set<string>();
  const opaque = new Set<string>();
  const dynamic: string[] = [];
  const modifierVariables = new Set<string>();
  for (const { fileName, code } of sources) {
    const source = ts.createSourceFile(
      fileName,
      code,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        let parent: ts.Node | undefined = node.parent;
        let classAttribute = false;
        while (parent && !ts.isStatement(parent)) {
          if (
            ts.isJsxAttribute(parent) &&
            parent.name.getText(source) === "className"
          )
            classAttribute = true;
          parent = parent.parent;
        }
        const text = node.text;
        if (classAttribute && /^--[a-z][a-z0-9-]*$/.test(text)) modifierVariables.add(text);
        if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          const suffix = /[a-z][a-z0-9_-]*$/.exec(text)?.[0];
          if (suffix) dynamic.push(suffix);
        }
        for (const name of candidates) {
          if (text.includes(name)) (classAttribute ? seen : opaque).add(name);
        }
        if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
          const suffix = /[a-z][a-z0-9_-]*$/.exec(text)?.[0];
          const template = ts.isTemplateExpression(node.parent)
            ? node.parent
            : ts.isTemplateSpan(node.parent) &&
                ts.isTemplateExpression(node.parent.parent)
              ? node.parent.parent
              : undefined;
          const next = ts.isTemplateHead(node)
            ? template?.templateSpans[0]?.expression
            : template?.templateSpans[
                template.templateSpans.findIndex(
                  (span) => span.literal === node,
                ) + 1
              ]?.expression;
          if (suffix && !suffix.endsWith("--") && !safeModifier(next))
            dynamic.push(suffix);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const names = new Map<string, string>();
  Array.from(candidates)
    .filter(
      (name) =>
        seen.has(name) &&
        !opaque.has(name) &&
        !dynamic.some((prefix) => name.startsWith(prefix)),
    )
    .sort()
    .forEach((name, index) => names.set(name, `_${index.toString(36)}`));
  const variables = Array.from(
    new Set(
      Array.from(css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g), (match) => match[1]),
    ),
  ).sort();
  variables.filter(name => !modifierVariables.has(name)).forEach((name, index) =>
    names.set(name, `--_${index.toString(36)}`),
  );
  return names;
}

export function compactStyleText(
  text: string,
  names: ReadonlyMap<string, string>,
): string {
  return text.replace(
    /(?<![a-zA-Z0-9_-])(?:--[a-z][a-z0-9-]*|[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*)/g,
    (token) => names.get(token) ?? token,
  );
}

export function compactStyleNames(sourceRoot: string): Plugin {
  let names: Map<string, string>;
  const root = sourceRoot.replaceAll("\\", "/");
  return {
    name: "mivlet-compact-style-names",
    enforce: "pre",
    apply: "build",
    buildStart() {
      const paths = files(sourceRoot);
      names = styleNameMap(
        paths
          .filter((path) => path.endsWith(".css"))
          .map((path) => readFileSync(path, "utf8"))
          .join("\n"),
        paths
          .filter(
            (path) =>
              /\.[jt]sx?$/.test(path) &&
              !/\.(?:test|spec)\./.test(path) &&
              !/[/\\](?:dev|test|tests)[/\\]/.test(path),
          )
          .map((fileName) => ({
            fileName,
            code: readFileSync(fileName, "utf8"),
          })),
      );
    },
    transform(code, id) {
      if (
        !id.replaceAll("\\", "/").startsWith(`${root}/`) ||
        !/\.(?:css|[jt]sx?)(?:\?|$)/.test(id)
      )
        return null;
      const transformed = compactStyleText(code, names);
      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}
