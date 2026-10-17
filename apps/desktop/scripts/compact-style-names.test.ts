// @vitest-environment node
import { expect, it } from "vitest";
import { compactStyleNames, compactStyleSource, compactStyleText, styleNameMap } from "./compact-style-names";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
const sources = (code: string) => [{ fileName: "component.tsx", code }];
it("reserves the shortest names for frequent safe tokens", () => {
  const map = styleNameMap(
    ".a-card{} .z-card{} :root{--aaa:red;--zzz:blue} .z-card{color:var(--zzz);background:var(--zzz)}",
    sources('<div className="a-card z-card" /><div className="z-card" />'),
  );
  expect(map.get("z-card")).toBe("_0");
  expect(map.get("--zzz")).toBe("--_0");
});
it("compacts exclusively static class names consistently", () => {
  const map = styleNameMap(
    ".work-card__title {} .work-card__title--active {}",
    sources('<div className="work-card__title" />'),
  );
  expect(compactStyleText(".work-card__title--active", map)).toBe(
    "._0--active",
  );
  expect(
    compactStyleText('<div className="work-card__title" />', map),
  ).toContain('className="_0"');
});
it("preserves protocol values and opaque selector strings", () => {
  const map = styleNameMap(
    ".local-computer {}",
    sources(
      'const kind = "local-computer"; const node = <div className="local-computer" />;',
    ),
  );
  expect(map.has("local-computer")).toBe(false);
});
it("compacts class tokens without changing longer opaque IDs or ARIA references", () => {
  const code =
    '<section className="dialog-panel" aria-labelledby="dialog-panel-title"><h2 id="dialog-panel-title" /></section>';
  const map = styleNameMap(
    ".dialog-panel #dialog-panel-title {}",
    sources(code),
  );
  expect(compactStyleText(code, map)).toContain('className="_0"');
  expect(compactStyleText(code, map)).toContain(
    'aria-labelledby="dialog-panel-title"',
  );
  expect(compactStyleText(code, map)).toContain('id="dialog-panel-title"');
  expect(compactStyleText(".dialog-panel #dialog-panel-title {}", map)).toBe(
    "._0 #dialog-panel-title {}",
  );
});
it("preserves CSS module addresses while compacting the matching class basename", () => {
  const code = 'import "./dialog-panel.css"; import layer from "./dialog-panel.css?inline"; const selector = ".menu-panel:hover"; const ui = <><div className="dialog-panel" /><div className="menu-panel" /></>;';
  const map = styleNameMap(
    ".dialog-panel {} .menu-panel {}",
    sources(code),
  );
  expect(map.has("dialog-panel")).toBe(true);
  expect(map.has("menu-panel")).toBe(false);
  const transformed = compactStyleSource(code, "component.tsx", map);
  expect(transformed).toContain('import "./dialog-panel.css"');
  expect(transformed).toContain('from "./dialog-panel.css?inline"');
  expect(transformed).toContain('className="_0"');
  expect(transformed).toContain('".menu-panel:hover"');
});
it("keeps non-CSS imports and dynamic module addresses opaque", () => {
  for (const code of ['import "./dialog-panel";', 'const css = import("./dialog-panel.css");']) {
    const map = styleNameMap(".dialog-panel{}", sources(`${code} const ui = <div className="dialog-panel" />;`));
    expect(map.has("dialog-panel")).toBe(false);
  }
});
it("preserves classes assembled from dynamic prefixes", () => {
  const map = styleNameMap(
    ".window-controls__close {} .window-controls__minimize {}",
    sources("const node = <div className={`window-controls__${action}`} />;"),
  );
  expect(map.size).toBe(0);
});
it("keeps CSS variables and runtime setters consistent without rewriting modifiers", () => {
  const map = styleNameMap(
    ":root { --surface-muted: red; } .box--surface-muted {}",
  );
  expect(compactStyleText("var(--surface-muted)", map)).toBe("var(--_0)");
  expect(
    compactStyleText('style.setProperty("--surface-muted", color)', map),
  ).toContain('"--_0"');
  expect(compactStyleText("box--surface-muted", map)).toBe(
    "box--surface-muted",
  );
  expect(() => styleNameMap("._0title {} --_0:red")).toThrow("Reserved");
});

it("retains conditional modifier semantics while shortening the base", () => {
  const map = styleNameMap(
    ".work-card {} .work-card--active {}",
    sources(
      'const node = <div className={`work-card${active ? "--active" : ""}`} />;',
    ),
  );
  expect(compactStyleText("work-card--active", map)).toBe("_0--active");
});

it("does not rename a variable also used as a computed class modifier", () => {
  const map = styleNameMap(":root{--primary:red}.work-card--primary{}", sources('const node = <div className={`work-card${active ? "--primary" : ""}`} />;'));
  expect(map.has("--primary")).toBe(false);
});
it("preserves classes assembled by concatenation", () => {
  const map = styleNameMap(".window-controls__close{}", sources('const node = <div className={"window-controls__" + action} />; const other = <div className="window-controls__close" />;'));
  expect(map.has("window-controls__close")).toBe(false);
});

it("keeps imported CSS layers, custom properties and JSX consistent in a real build", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "mivlet-style-build-")));
  try {
    const src = join(fixture, "src");
    await mkdir(join(src, "layers"), { recursive: true });
    await writeFile(join(fixture, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
    await writeFile(join(src, "main.tsx"), 'import "./styles.css"; window.fixture = <div className="imported-card" />;');
    await writeFile(join(src, "styles.css"), '@import "./layers/card.css";');
    await writeFile(join(src, "layers/card.css"), ':root { --card-colour: red; } .imported-card { color: var(--card-colour); }');
    await build({
      root: fixture,
      configFile: false,
      logLevel: "silent",
      plugins: [compactStyleNames(src)],
      build: { manifest: true, minify: false },
    });
    const manifest = JSON.parse(await readFile(join(fixture, "dist/.vite/manifest.json"), "utf8"));
    const entry = manifest["index.html"];
    const js = await readFile(join(fixture, "dist", entry.file), "utf8");
    const css = await readFile(join(fixture, "dist", entry.css[0]), "utf8");
    expect(js).toContain('className: "_0"');
    expect(css).toContain("._0");
    expect(css).toContain("--_0:");
    expect(css).toContain("var(--_0)");
    expect(css).not.toMatch(/imported-card|card-colour/);
  } finally {
    // mkdtemp created this exact directory; it contains only this test's files.
    await rm(fixture, { recursive: true, force: true });
  }
});
