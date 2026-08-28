import { describe, expect, it } from "vitest";
import authConfig from "./auth.config";
import schema from "./schema";

describe("optional hosted account schema", () => {
  it("loads the Clerk auth config with a non-secret test fallback", () => {
    expect(authConfig.providers).toHaveLength(1);
    expect(authConfig.providers[0].domain).toMatch(/^https:\/\//);
    expect(authConfig.providers[0].applicationID).toBeTruthy();
  });

  it("loads the schema without live Convex credentials", () => {
    expect(schema).toBeTruthy();
  });
});
