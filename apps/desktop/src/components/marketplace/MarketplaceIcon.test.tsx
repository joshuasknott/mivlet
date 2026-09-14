import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { builtinPluginEntries } from "../../lib/builtin-plugins";
import { MarketplaceIcon } from "./MarketplaceIcon";

afterEach(cleanup);

describe("plugin icons", () => {
  it("renders the bundled Atlassian Rovo product mark instead of a generic glyph", () => {
    const { container } = render(<MarketplaceIcon id="atlassian-rovo" icon="communication" />);
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toMatch(/atlassian-rovo/);
  });

  it("renders the built-in Computer Use asset through the ordinary icon path", () => {
    const { container } = render(<MarketplaceIcon id={builtinPluginEntries[0].id} />);
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/computer/);
  });
});
