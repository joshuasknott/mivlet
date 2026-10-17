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

it("keeps the Side Chat list/editor off the shell and conversation notice graph", () => {
  const list = resolve(sourceRoot, "components/conversation/SideChats.tsx");
  const notice = resolve(sourceRoot, "components/conversation/SideChatContextNotice.tsx");
  const panel = resolve(sourceRoot, "shell/WorkspaceContextPanel.tsx");
  expect(staticGraph(list).has(notice)).toBe(true);
  expect(staticGraph(resolve(sourceRoot, "shell/ConversationPane.tsx")).has(notice)).toBe(true);
  for (const entry of [panel, notice, resolve(sourceRoot, "shell/ConversationPane.tsx")]) {
    expect(staticGraph(entry).has(list)).toBe(false);
  }
  // The functionality still has a real deferred entry; removing it is not an optimization.
  const source = ts.createSourceFile(panel, readFileSync(panel, "utf8"), ts.ScriptTarget.Latest, true);
  const dynamicImports: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      dynamicImports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(dynamicImports).toContain("../components/conversation/SideChats");
});

it("loads phone and external access controls only through their Settings disclosure", () => {
  const entry = resolve(sourceRoot, "components/pages/SettingsPage.tsx");
  const settings = resolve(sourceRoot, "components/settings/McpServerSettings.tsx");
  const phone = resolve(sourceRoot, "components/settings/ManagedPhoneSettings.tsx");
  expect(staticGraph(entry).has(settings)).toBe(false);
  expect(staticGraph(entry).has(phone)).toBe(false);
  expect(staticGraph(settings).has(phone)).toBe(true);
  const source = readFileSync(entry, "utf8");
  expect(source).toContain('import("../settings/McpServerSettings")');
  expect(source).toContain("externalOpen && <Suspense");
});
