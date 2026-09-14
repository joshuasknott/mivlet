import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import ts from "typescript";
import type { Plugin } from "vite";

const ALL_WEIGHTS = ["bold", "duotone", "fill", "light", "regular", "thin"];
type IconWeights = Map<string, Set<string>>;
interface IconSource {
  fileName: string;
  code: string;
}

function literalWeights(node: ts.Node | undefined): string[] {
  if (node && ts.isStringLiteral(node)) return [node.text];
  if (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)))
    return literalWeights(node.expression);
  if (node && ts.isConditionalExpression(node))
    return [
      ...literalWeights(node.whenTrue),
      ...literalWeights(node.whenFalse),
    ];
  return ALL_WEIGHTS;
}

/** Unknown props or indirect uses retain every variant; context affects all icons. */
export function collectIconWeights(sources: IconSource[]): IconWeights | null {
  const weights: IconWeights = new Map();
  let unknownConsumer = false;
  for (const { fileName, code } of sources) {
    const source = ts.createSourceFile(
      fileName,
      code,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = new Map<string, string>();
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith("@phosphor-icons/react")) continue;
      const icon = /^@phosphor-icons\/react\/dist\/csr\/(\w+)$/.exec(
        specifier,
      )?.[1];
      const bindings = statement.importClause?.namedBindings;
      if (
        !icon ||
        !bindings ||
        !ts.isNamedImports(bindings) ||
        statement.importClause?.name
      )
        return null;
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) imports.set(binding.name.text, icon);
      }
      if (!weights.has(icon)) weights.set(icon, new Set(["regular"]));
    }
    const add = (name: string, requested: string[]) => {
      const icon = imports.get(name);
      if (icon) for (const weight of requested) weights.get(icon)!.add(weight);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isJsxClosingElement(node)) return;
      // Re-exports, dynamic imports and require calls may forward arbitrary props.
      if (
        ts.isStringLiteral(node) &&
        node.text.startsWith("@phosphor-icons/react")
      )
        unknownConsumer = true;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (ts.isIdentifier(node.tagName) && imports.has(node.tagName.text)) {
          for (const attribute of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(attribute))
              add(node.tagName.text, ALL_WEIGHTS);
            else if (attribute.name.getText(source) === "weight") {
              const value = attribute.initializer;
              add(
                node.tagName.text,
                literalWeights(
                  value && ts.isJsxExpression(value) ? value.expression : value,
                ),
              );
            }
          }
          ts.forEachChild(node.attributes, visit);
          return;
        }
      }
      if (ts.isIdentifier(node) && imports.has(node.text))
        add(node.text, ALL_WEIGHTS);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (unknownConsumer) return null;
  }
  return weights;
}

/** Keep the package's own SVG paths and React wrapper, pruning only Map entries. */
export function pruneIconDefinition(
  code: string,
  weights: ReadonlySet<string>,
): string {
  const source = ts.createSourceFile(
    "icon.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let entries: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Map"
    ) {
      const argument = node.arguments?.[0];
      if (argument && ts.isArrayLiteralExpression(argument)) entries = argument;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!entries) return code;
  const variants = entries.elements.map((entry) => {
    const key =
      ts.isArrayLiteralExpression(entry) && entry.elements.length === 2
        ? entry.elements[0]
        : undefined;
    return key && ts.isStringLiteral(key) ? { key: key.text, entry } : null;
  });
  // A package format change must preserve the original rather than lose artwork.
  if (
    variants.length !== ALL_WEIGHTS.length ||
    !ALL_WEIGHTS.every((weight) =>
      variants.some((variant) => variant?.key === weight),
    )
  )
    return code;
  const kept = variants.filter(
    (variant) => variant && weights.has(variant.key),
  );
  if (kept.length === variants.length || kept.length === 0) return code;
  return (
    code.slice(0, entries.getStart(source)) +
    `[${kept.map((variant) => variant!.entry.getText(source)).join(",")}]` +
    code.slice(entries.end)
  );
}

function readSources(directory: string): IconSource[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      [
        "node_modules",
        "dist",
        "target",
        "_generated",
        "tests",
        "test",
        "fixtures",
      ].includes(entry.name)
    )
      return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readSources(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name)
      ? [{ fileName: path, code: readFileSync(path, "utf8") }]
      : [];
  });
}

export function spriteGlyph(
  icon: string,
  weight: string,
  glyph: ReactNode,
): string {
  return `<g id="${icon}-${weight}">${renderToStaticMarkup(glyph)}</g>`;
}

export function pruneUnusedIconWeights(sourceRoots: string[]): Plugin {
  const requireModule = createRequire(import.meta.url);
  let weights: IconWeights | null;
  let spriteId: string;
  let iconBaseId: string;
  const wrapperId = "\0mivlet-icon-wrapper";
  const symbols = new Map<string, string>();
  return {
    name: "mivlet-icon-weights",
    apply: "build",
    enforce: "pre",
    buildStart() {
      weights = collectIconWeights(sourceRoots.flatMap(readSources));
      symbols.clear();
      spriteId = this.emitFile({ type: "asset", name: "icons.svg" });
    },
    resolveId(id) {
      return id === "mivlet-icon-wrapper" ? wrapperId : null;
    },
    load(id) {
      if (id !== wrapperId) return null;
      return `import {forwardRef,createElement} from "react"; import Base from ${JSON.stringify(iconBaseId)}; const sprite=import.meta.ROLLUP_FILE_URL_${spriteId}; export function make(weights,name) { if(Array.isArray(weights)) weights=new Map(weights.map(weight=>[weight,createElement("use",{href:sprite+"#"+name+"-"+weight})])); const Icon=forwardRef((props,ref)=>createElement(Base,{ref,...props,weights})); Icon.displayName=name+"Icon"; return Icon; }`;
    },
    transform(code, id) {
      const component =
        /[/\\]@phosphor-icons[/\\]react[/\\]dist[/\\]csr[/\\](\w+)\.es\.js$/.exec(
          id,
        )?.[1];
      if (component && weights?.has(component)) {
        iconBaseId = id.replace(/csr[/\\]\w+\.es\.js$/, "lib/IconBase.es.js");
        return {
          code: `import weights from "../defs/${component}.es.js"; import {make} from "mivlet-icon-wrapper"; const Icon=make(weights,${JSON.stringify(component)}); export {Icon as ${component},Icon as ${component}Icon};`,
          map: null,
        };
      }
      const icon =
        /[/\\]@phosphor-icons[/\\]react[/\\]dist[/\\]defs[/\\](\w+)\.es\.js$/.exec(
          id,
        )?.[1];
      const used = icon && weights?.get(icon);
      if (!used) return null;
      // Paths are immutable artwork. Keep them in one cached SVG asset instead
      // of parsing and allocating the same glyph trees in JavaScript. The
      // package's IconBase still owns size, colour, mirroring, title and ref.
      const glyphs: Map<string, ReactNode> = requireModule(id).default;
      if (!(glyphs instanceof Map))
        return { code: pruneIconDefinition(code, used), map: null };
      const entries: string[] = [];
      for (const weight of Array.from(used)) {
        const glyph = glyphs.get(weight);
        if (!glyph) throw new Error(`Missing ${icon} icon weight ${weight}`);
        const key = `${icon}-${weight}`;
        symbols.set(key, spriteGlyph(icon, weight, glyph));
        entries.push(JSON.stringify(weight));
      }
      return { code: `export default [${entries.join(",")}];`, map: null };
    },
    buildEnd() {
      this.setAssetSource(
        spriteId,
        `<svg xmlns="http://www.w3.org/2000/svg">${Array.from(symbols)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, value]) => value)
          .join("")}</svg>`,
      );
    },
  };
}
