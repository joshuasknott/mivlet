// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const artifact = resolve(sourceRoot, "components/conversation/ArtifactPreview.tsx");
const output = resolve(sourceRoot, "components/conversation/OutputEditor.tsx");
const office = resolve(sourceRoot, "components/conversation/OfficePreview.tsx");

/** The emitted feature-chunk guard cannot see a shared engine moved into index.
 * Follow real relative static imports/reexports, excluding erased type edges. */
function staticGraph(entry: string) {
  const visited = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly) continue;
        if (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
        specifier = node.moduleSpecifier;
      } else if (ts.isExportDeclaration(node)) {
        if (node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.every(element => element.isTypeOnly)) continue;
        specifier = node.moduleSpecifier;
      }
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
      const path = resolve(dirname(file), specifier.text);
      const target = [path, `${path}.ts`, `${path}.tsx`, resolve(path, "index.ts"), resolve(path, "index.tsx")]
        .find(candidate => /\.tsx?$/.test(candidate) && existsSync(candidate));
      if (target) visit(target);
    }
  }
  visit(entry);
  return visited;
}

it("keeps both shared engines behind the artifact entry without a shell cycle", () => {
  const graph = staticGraph(artifact);
  expect(graph.has(output)).toBe(true);
  expect(graph.has(office)).toBe(true);
  expect(graph.has(resolve(sourceRoot, "components/navigation/PanelContent.tsx"))).toBe(false);
  expect(graph.has(resolve(sourceRoot, "components/search/SearchFileDialog.tsx"))).toBe(false);
});

it.each(["components/navigation/PanelContent.tsx", "components/search/SearchFileDialog.tsx"])("does not eagerly load preview engines through %s", entry => {
  const graph = staticGraph(resolve(sourceRoot, entry));
  expect(graph.has(artifact)).toBe(false);
  expect(graph.has(output)).toBe(false);
  expect(graph.has(office)).toBe(false);
});
