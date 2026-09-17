import { describe, expect, it } from "vitest";
import schema from "./schema";

describe("optional hosted account schema", () => {
  it("loads the schema without live Convex credentials", () => {
    expect(schema).toBeTruthy();
  });
});
