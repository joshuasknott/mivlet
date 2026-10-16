// @vitest-environment node
import { expect, it } from "vitest";
import { compactStyleNames, compactStyleText, styleNameMap } from "./compact-style-names";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
const sources = (code: string) => [{ fileName: "component.tsx", code }];
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
