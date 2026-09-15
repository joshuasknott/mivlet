import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyLocalEnvironment } from "./local-env.mjs";

test("local environment overrides inherited values without disturbing unrelated keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "mivlet-local-env-"));
  const path = join(directory, ".env.local");
  try {
    writeFileSync(
      path,
      [
        "MIVLET_GOOGLE_OAUTH_CLIENT_ID=local-client",
        'MIVLET_AUTH_BROKER_URL="https://broker.example/"',
        "",
      ].join("\n"),
      "utf8",
    );
    const environment = {
      MIVLET_GOOGLE_OAUTH_CLIENT_ID: "stale-inherited-client",
      UNRELATED: "preserved",
    };

    const applied = applyLocalEnvironment(path, environment);

    assert.deepEqual(applied, [
      "MIVLET_AUTH_BROKER_URL",
      "MIVLET_GOOGLE_OAUTH_CLIENT_ID",
    ]);
    assert.equal(environment.MIVLET_GOOGLE_OAUTH_CLIENT_ID, "local-client");
    assert.equal(environment.MIVLET_AUTH_BROKER_URL, "https://broker.example/");
    assert.equal(environment.UNRELATED, "preserved");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("missing local environment leaves inherited values unchanged", () => {
  const environment = { EXISTING: "value" };
  assert.deepEqual(
    applyLocalEnvironment(join(tmpdir(), "mivlet-missing-local-env"), environment),
    [],
  );
  assert.deepEqual(environment, { EXISTING: "value" });
});
