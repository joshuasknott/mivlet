import { describe, expect, it } from "vitest";
import { FixtureTransport } from "./transport";
import { readFixture } from "./fixtures-loader";

describe("FixtureTransport", () => {
  it("replays a recorded fixture line by line, dropping blanks", async () => {
    const transport = new FixtureTransport(["data: line-a", "", "data: line-b", ""]);
    const lines: string[] = [];
    for await (const line of transport.stream({ providerId: "openai" } as never)) {
      lines.push(line);
    }
    expect(lines).toEqual(["data: line-a", "data: line-b"]);
  });

  it("reads a recorded fixture file from disk", () => {
    const text = readFixture("openai.txt");
    expect(text).toContain("data: {");
    expect(text.trim().endsWith("[DONE]")).toBe(true);
  });

  it("builds from a fixture text via fromText", async () => {
    const transport = FixtureTransport.fromText("data: a\ndata: b\n\n");
    const lines: string[] = [];
    for await (const line of transport.stream({ providerId: "openai" } as never)) {
      lines.push(line);
    }
    expect(lines).toEqual(["data: a", "data: b"]);
  });
});
