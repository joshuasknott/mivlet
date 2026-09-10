import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  collectIconWeights as collect,
  pruneIconDefinition,
} from "./icon-weights";

const collectIconWeights = (sources: string[]) =>
  collect(sources.map((code) => ({ code, fileName: "source.tsx" })));

const imported =
  'import { Check as Tick } from "@phosphor-icons/react/dist/csr/Check";';
const allWeights = ["bold", "duotone", "fill", "light", "regular", "thin"];

describe("icon weight analysis", () => {
  it("handles indirect uses inside generic TypeScript functions", () => {
    const result = collect([
      {
        fileName: "icons.ts",
        code: `${imported} export const make = <T>(props: T) => Tick(props);`,
      },
    ]);
    expect([...result!.get("Check")!].sort()).toEqual(allWeights);
  });
  it("combines default, explicit and conditional weights across consumers and aliases", () => {
    const result = collectIconWeights([
      `${imported} const icon = <Tick />;`,
      `${imported} const icon = <Tick weight="bold" />;`,
      `${imported} const icon = <Tick weight={selected ? "fill" : "regular"} />;`,
    ]);
    expect([...result!.get("Check")!].sort()).toEqual([
      "bold",
      "fill",
      "regular",
    ]);
  });

  it.each([
    "<Tick {...props} />",
    "<Tick weight={weight} />",
    "<Tick weight={selected ? props.weight : 'regular'} />",
    "<Wrapper icon={Tick} />",
    "{ icon: Tick }",
    "Tick({ weight: 'thin' })",
  ])(
    "preserves all variants when usage is indirect or unknown: %s",
    (usage) => {
      const result = collectIconWeights([`${imported} const icon = ${usage};`]);
      expect([...result!.get("Check")!].sort()).toEqual(allWeights);
    },
  );

  it("preserves all weights for exported icons and unknown context", () => {
    expect(
      [
        ...collectIconWeights([`${imported} export { Tick };`])!.get("Check")!,
      ].sort(),
    ).toEqual(allWeights);
    expect(
      collectIconWeights([
        `${imported} import { IconContext } from '@phosphor-icons/react';`,
      ]),
    ).toBeNull();
    expect(
      collectIconWeights(["import * as Icons from '@phosphor-icons/react';"]),
    ).toBeNull();
    expect(
      collectIconWeights([
        "export { Check } from '@phosphor-icons/react/dist/csr/Check';",
      ]),
    ).toBeNull();
    expect(
      collectIconWeights(["const icons = import('@phosphor-icons/react');"]),
    ).toBeNull();
  });

  it("ignores type-only imports and unrelated packages", () => {
    expect(
      collectIconWeights([
        `import type { IconWeight } from '@phosphor-icons/react'; ${imported} const icon = <Tick />;`,
      ])!.get("Check"),
    ).toEqual(new Set(["regular"]));
    expect(
      collectIconWeights([
        "import { Check } from './local'; const icon = <Check />;",
      ])!.size,
    ).toBe(0);
  });
});

function variantBodies(code: string) {
  const source = ts.createSourceFile(
    "icon.js",
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  const variants = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      ts.isStringLiteral(node.elements[0])
    ) {
      variants.set(node.elements[0].text, node.elements[1].getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return variants;
}

describe("icon definition pruning", () => {
  const packageRoot = dirname(
    createRequire(import.meta.url).resolve(
      "@phosphor-icons/react/package.json",
    ),
  );
  it.each(["Check", "ShieldCheck", "Browser", "GoogleLogo", "CursorClick"])(
    "retains identical artwork for every requested %s variant",
    (icon) => {
      const original = readFileSync(
        join(packageRoot, `dist/defs/${icon}.es.js`),
        "utf8",
      );
      for (const weight of allWeights) {
        const result = pruneIconDefinition(original, new Set([weight]));
        expect(variantBodies(result)).toEqual(
          new Map([[weight, variantBodies(original).get(weight)]]),
        );
        expect(result.length).toBeLessThan(original.length);
        expect(pruneIconDefinition(original, new Set(allWeights))).toBe(
          original,
        );
      }
    },
  );

  it("leaves unrecognized upstream formats untouched", () => {
    const code = 'export default new Map([["regular", draw()]]);';
    expect(pruneIconDefinition(code, new Set(["regular"]))).toBe(code);
    expect(
      pruneIconDefinition("export default {};", new Set(["regular"])),
    ).toBe("export default {};");
  });
});
