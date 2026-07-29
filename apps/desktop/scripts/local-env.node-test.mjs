import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyLocalEnvironment } from "./local-env.mjs";

test("local environment overrides inherited values without disturbing unrelated keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "fable-local-env-"));
  const path = join(directory, ".env.local");
  try {
    writeFileSync(
      path,
      [
        "FABLE_GOOGLE_OAUTH_CLIENT_ID=local-client",
        'FABLE_AUTH_BROKER_URL="https://broker.example/"',
        "",
      ].join("\n"),
      "utf8",
    );
    const environment = {
      FABLE_GOOGLE_OAUTH_CLIENT_ID: "stale-inherited-client",
      UNRELATED: "preserved",
    };

    const applied = applyLocalEnvironment(path, environment);

    assert.deepEqual(applied, [
      "FABLE_AUTH_BROKER_URL",
      "FABLE_GOOGLE_OAUTH_CLIENT_ID",
    ]);
    assert.equal(environment.FABLE_GOOGLE_OAUTH_CLIENT_ID, "local-client");
    assert.equal(environment.FABLE_AUTH_BROKER_URL, "https://broker.example/");
    assert.equal(environment.UNRELATED, "preserved");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("missing local environment leaves inherited values unchanged", () => {
  const environment = { EXISTING: "value" };
  assert.deepEqual(
    applyLocalEnvironment(join(tmpdir(), "fable-missing-local-env"), environment),
    [],
  );
  assert.deepEqual(environment, { EXISTING: "value" });
});
