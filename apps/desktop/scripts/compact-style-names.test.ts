import { expect, it } from "vitest";
import { compactStyleText, styleNameMap } from "./compact-style-names";
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
it("still preserves exact tokens inside imports and opaque selectors", () => {
  const map = styleNameMap(
    ".dialog-panel {} .menu-panel {}",
    sources(
      'import "./dialog-panel.css"; const selector = ".menu-panel:hover"; const ui = <><div className="dialog-panel" /><div className="menu-panel" /></>;',
    ),
  );
  expect(map.has("dialog-panel")).toBe(false);
  expect(map.has("menu-panel")).toBe(false);
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
