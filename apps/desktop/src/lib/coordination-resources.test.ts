import { describe, expect, it } from "vitest";
import { coordinationResource } from "./coordination-resources";

describe("coordinated resource reservations", () => {
  it("normalizes equivalent private file paths and separates agent namespaces", () => {
    const args = JSON.stringify({ path: "Reports\\./Result.TXT", content: "secret contents" });
    expect(coordinationResource("write-file", args, "a")).toBe("agent-file:a:reports/result.txt");
    expect(coordinationResource("write-file", args, "b")).toBe("agent-file:b:reports/result.txt");
    expect(() => coordinationResource("write-file", '{"path":"../other"}', "a")).toThrow("traverse");
  });
  it("reserves opaque connector writes conservatively without exposing their payload", () => {
    expect(coordinationResource("connector-call", '{"connectorId":"Drive","input":{"secret":"value"}}', "a")).toBe("connector:drive");
    expect(coordinationResource("read-file", '{"path":"brief.txt"}', "a")).toBeNull();
  });
});
