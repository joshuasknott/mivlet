// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { compactStyleNames, styleNameMap } from "./compact-style-names";

it("compacts imported CSS with its JSX and hashes the resulting styles", async () => {
  const directory = realpathSync.native(await mkdtemp(join(tmpdir(), "mivlet-style-build-")));
  const source = join(directory, "src");
  await mkdir(source);
  const css = ":root{--ink-color:#123456}.composer-input{display:grid;color:var(--ink-color)}.late-card{border:1px solid var(--ink-color)}";
  const main = 'import "./styles.css";globalThis.fixture = <div className="composer-input" style={{color:"var(--ink-color)"}}/>;globalThis.loadFixture = () => import("./late");';
  const late = 'import "./late.css";export default <div className="late-card"/>;';
  try {
    await Promise.all([
      writeFile(join(directory, "index.html"), '<script type="module" src="/src/main.tsx"></script>'),
      writeFile(join(source, "main.tsx"), main),
      writeFile(join(source, "styles.css"), '@import "./tokens.css";@import "./imported.css";'),
      writeFile(join(source, "tokens.css"), ":root{--ink-color:#123456}"),
      writeFile(join(source, "imported.css"), ".composer-input{display:grid;color:var(--ink-color)}"),
      writeFile(join(source, "late.tsx"), late),
      writeFile(join(source, "late.css"), ".late-card{border:1px solid var(--ink-color)}"),
    ]);
    const compile = async () => {
      const result = await build({
        root: directory, configFile: false, logLevel: "silent",
        plugins: [compactStyleNames(source)],
        build: { write: false, cssCodeSplit: true, minify: false },
      });
      if (!("output" in result)) throw new Error("Expected a single application build.");
      return result.output;
    };
    const map = styleNameMap(css, [
      { fileName: "main.tsx", code: main }, { fileName: "late.tsx", code: late },
    ]);
    const output = await compile();
    const scripts = output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
    const styles = output.filter(item => item.type === "asset" && item.fileName.endsWith(".css"));
    const emittedCss = styles.map(item => String(item.source)).join("\n");
    for (const name of ["composer-input", "late-card"]) {
      expect(map.has(name)).toBe(true);
      expect(scripts).toContain(`"${map.get(name)}"`);
      expect(emittedCss).toContain(`.${map.get(name)}{`);
      expect(emittedCss).not.toContain(`.${name}`);
    }
    expect(scripts).toContain(`var(${map.get("--ink-color")})`);
    expect(emittedCss).toContain(`${map.get("--ink-color")}:#123456`);
    expect(emittedCss).not.toContain("--ink-color");
    const mainStyles = styles.find(item => String(item.source).includes("display:grid"));
    expect(styles).toHaveLength(2);
    expect(mainStyles).toBeDefined();
    expect(String(mainStyles?.source)).not.toContain(`.${map.get("late-card")}`);

    // A map change must change CSS filenames as well as bytes, so cached
    // imported styles can never retain a different map from the new JS.
    await writeFile(join(source, "late.tsx"), late.replace('className="late-card"', 'className="late-card late-card late-card late-card"'));
    const changed = (await compile()).filter(item => item.type === "asset" && item.fileName.endsWith(".css"));
    expect(changed.map(item => item.fileName)).not.toEqual(styles.map(item => item.fileName));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
