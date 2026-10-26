import assert from "node:assert/strict";
import { test } from "node:test";
import { publicBuildEnvironment } from "./public-build-env.mjs";

test("desktop launch configuration carries public account endpoints without local secrets", () => {
  const result = publicBuildEnvironment({ PATH: "/usr/bin" }, {
    MIVLET_CLERK_ACCOUNT_ENTRY_URL: "https://accounts.example.test/desktop/start",
    MIVLET_CONVEX_URL: "https://example.convex.cloud",
    MIVLET_GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-private-value",
    OPENAI_API_KEY: "synthetic-private-value",
    MIVLET_CLERK_ALLOW_MOCK: "1",
  });
  assert.deepEqual(result, {
    PATH: "/usr/bin",
    MIVLET_CLERK_ACCOUNT_ENTRY_URL: "https://accounts.example.test/desktop/start",
    MIVLET_CONVEX_URL: "https://example.convex.cloud",
  });
});

test("an explicitly empty current setting cannot inherit a legacy endpoint", () => {
  const result = publicBuildEnvironment({}, {
    MIVLET_CONVEX_URL: "",
    FABLE_CONVEX_URL: "https://old.convex.cloud",
  });
  assert.equal(result.MIVLET_CONVEX_URL, "");
});
