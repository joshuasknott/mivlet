import { describe, expect, it } from "vitest";
import { connectorLogos } from "./connector-logos";

describe("connector icon assets", () => {
  it("bundles the licensed Atlassian Rovo product mark", () => {
    expect(connectorLogos["atlassian-rovo"]).toMatch(/atlassian-rovo/);
  });
  it("does not bundle an icon for a retired route", () => {
    expect(connectorLogos["todoist"]).toBeUndefined();
  });
});
