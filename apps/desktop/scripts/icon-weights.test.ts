import { createElement, createRef, forwardRef } from "react";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  collectIconWeights as collect,
  pruneIconDefinition,
  spriteGlyph,
  pruneUnusedIconWeights,
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

describe("cached icon artwork", () => {
  it.each(["Check", "ShieldCheck", "Browser", "GoogleLogo", "CursorClick"])(
    "preserves every %s variant and its reference id",
    (icon) => {
      const requireModule = createRequire(import.meta.url);
      const root = dirname(
        requireModule.resolve("@phosphor-icons/react/package.json"),
      );
      const glyphs = requireModule(
        join(root, `dist/defs/${icon}.es.js`),
      ).default;
      for (const weight of allWeights) {
        const glyph = glyphs.get(weight);
        expect(spriteGlyph(icon, weight, glyph)).toBe(
          `<g id="${icon}-${weight}">${renderToStaticMarkup(glyph)}</g>`,
        );
        expect(spriteGlyph(icon, weight, glyph)).toContain("<path");
      }
    },
  );
});

it("preserves the icon wrapper contract after consolidation", async () => {
  const requireModule = createRequire(import.meta.url);
  const root = dirname(
    requireModule.resolve("@phosphor-icons/react/package.json"),
  );
  const plugin = pruneUnusedIconWeights([join(process.cwd(), "src")]);
  const start =
    typeof plugin.buildStart === "function"
      ? plugin.buildStart
      : plugin.buildStart!.handler;
  await start.call({ emitFile: () => "fixture" } as never, {} as never);
  const transform =
    typeof plugin.transform === "function"
      ? plugin.transform
      : plugin.transform!.handler;
  const id = join(root, "dist/csr/Check.es.js");
  const transformed = await transform.call(
    {} as never,
    readFileSync(id, "utf8"),
    id,
  );
  expect(transformed).toHaveProperty(
    "code",
    expect.stringContaining("mivlet-icon-wrapper"),
  );
  const load =
    typeof plugin.load === "function" ? plugin.load : plugin.load!.handler;
  const source = (await load.call(
    {} as never,
    "\0mivlet-icon-wrapper",
  )) as string;
  const body = source
    .replace(/import [^;]+;/g, "")
    .replace(/const sprite=[^;]+;/, "")
    .replace("export function make", "return function make");
  const make = new Function(
    "forwardRef",
    "createElement",
    "Base",
    "sprite",
    body,
  )(
    forwardRef,
    createElement,
    requireModule(join(root, "dist/lib/IconBase.es.js")).default,
    "/icons.svg",
  );
  const Icon = make(["regular", "bold"], "Check");
  const ref = createRef<SVGSVGElement>();
  const view = render(
    createElement(Icon, {
      ref,
      size: 32,
      color: "purple",
      weight: "bold",
      mirrored: true,
      "aria-label": "Confirm",
    }),
  );
  expect(ref.current).toBe(view.container.querySelector("svg"));
  expect(ref.current).toHaveAttribute("width", "32");
  expect(ref.current).toHaveAttribute("height", "32");
  expect(ref.current).toHaveAttribute("fill", "purple");
  expect(ref.current).toHaveAttribute("aria-label", "Confirm");
  expect(ref.current).toHaveAttribute("transform", "scale(-1, 1)");
  expect(ref.current?.querySelector("use")).toHaveAttribute(
    "href",
    "/icons.svg#Check-bold",
  );
});
