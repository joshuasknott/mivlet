// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { compactStyleNames } from "./compact-style-names";

it("keeps imported CSS, JSX selectors and custom properties consistent in a production build", async () => {
  const root = await mkdtemp(join(tmpdir(), "mivlet-style-import-"));
  const src = join(root, "src");
  try {
    await mkdir(join(src, "layers"), { recursive: true });
    await writeFile(join(src, "entry.css"), '@import "./layers/base.css";');
    await writeFile(
      join(src, "layers/base.css"),
      `
      @import "./nested.css";
      :root { --fixture-tone: rgb(12, 34, 56); }
      .fixture-card { color: var(--fixture-tone); }
      .fixture-card--active { padding: 7px; }
      .fixture-action__close { margin: 3px; }
      .fixture-protocol { display: block; }
    `,
    );
    await writeFile(
      join(src, "layers/nested.css"),
      ".fixture-label { font-weight: 700; }",
    );
    await writeFile(
      join(src, "entry.tsx"),
      `
      import "./entry.css";
      function h(tag, props) {
        const element = document.createElement(tag);
        Object.assign(element, props);
        document.body.append(element);
        return element;
      }
      const active = true;
      const action = "close";
      const protocol = "fixture-protocol";
      window.fixture = [
        <div className={\`fixture-card\${active ? "--active" : ""}\`} />,
        <div className="fixture-card" />,
        <span className="fixture-label" />,
        <button className={"fixture-action__" + action} />,
        <button className="fixture-action__close" />,
        <div className="fixture-protocol" id={protocol} />,
      ];
      document.documentElement.style.setProperty("--fixture-tone", "rgb(12, 34, 56)");
    `,
    );
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [compactStyleNames(src)],
      esbuild: { jsxFactory: "h", jsxFragment: "Fragment" },
      build: {
        write: false,
        minify: false,
        cssMinify: false,
        cssCodeSplit: false,
        rollupOptions: {
          input: join(src, "entry.tsx"),
          output: { format: "iife" },
        },
      },
    });
    if (!("output" in result))
      throw new Error("Expected a single fixture bundle");
    const js = result.output.find((item) => item.type === "chunk");
    const css = result.output.find(
      (item) => item.type === "asset" && item.fileName.endsWith(".css"),
    );
    if (!js || !css || css.type !== "asset")
      throw new Error("Missing fixture assets");
    const cssText = String(css.source);
    const dom = new JSDOM(
      "<!doctype html><html><head></head><body></body></html>",
      { runScripts: "outside-only" },
    );
    const { document, getComputedStyle } = dom.window;
    const sheet = document.createElement("style");
    sheet.textContent = cssText;
    document.head.append(sheet);
    try {
      // Execute only this local synthetic fixture, never arbitrary build output.
      dom.window.eval(js.code);
      const fixture = (dom.window as unknown as { fixture: HTMLElement[] })
        .fixture;
      expect(fixture[0].className).toMatch(/^_[0-9a-z]+--active$/);
      expect(getComputedStyle(fixture[0]).padding).toBe("7px");
      expect(getComputedStyle(fixture[2]).fontWeight).toBe("700");
      expect(cssText).toContain(`.${fixture[1].className}`);
      expect(cssText).not.toContain("fixture-card");
      expect(cssText).not.toContain("fixture-label");
      expect(cssText).not.toContain("--fixture-tone");
      expect(cssText).toContain("var(--_0)");
      expect(document.documentElement.style.getPropertyValue("--_0")).toBe(
        "rgb(12, 34, 56)",
      );
      expect(fixture[3].className).toBe("fixture-action__close");
      expect(fixture[4].className).toBe("fixture-action__close");
      expect(getComputedStyle(fixture[3]).margin).toBe("3px");
      expect(fixture[5].id).toBe("fixture-protocol");
      expect(fixture[5].className).toBe("fixture-protocol");
    } finally {
      dom.window.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
