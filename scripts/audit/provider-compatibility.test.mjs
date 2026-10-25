import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdk = realpathSync(join(root, "packages/agent-host/node_modules/@opencode/sdk"));
const core = realpathSync(resolve(sdk, "../core"));
const coreRequire = createRequire(join(core, "package.json"));
const providerEntry = coreRequire.resolve("gitlab-ai-provider");
const providerRequire = createRequire(providerEntry);

test("the bundled GitLab adapter resolves patched Zod 4", () => {
  assert.equal(providerRequire("zod/package.json").version, "4.6.6");
});

for (const format of ["commonjs", "module"]) {
  test(`GitLab ${format} validates direct-access headers with Zod 4`, async () => {
    const provider = format === "commonjs"
      ? coreRequire("gitlab-ai-provider")
      : await import(pathToFileURL(join(dirname(providerEntry), "index.mjs")).href);
    let payload = { headers: { "x-test": "synthetic" }, token: "test-token" };
    const client = new provider.GitLabDirectAccessClient({
      instanceUrl: "https://gitlab.example.test",
      getHeaders: () => ({}),
      fetch: async () => new Response(JSON.stringify(payload)),
    });
    assert.deepEqual(await client.getDirectAccessToken(), payload);
    payload = { headers: { "x-test": 42 }, token: "test-token" };
    await assert.rejects(client.getDirectAccessToken(true), /Failed to get direct access token/);
    payload = { headers: {}, token: 42 };
    await assert.rejects(client.getDirectAccessToken(true), /Failed to get direct access token/);
  });
}

test("OpenUI retains the AG-UI event names it consumes", () => {
  const headless = realpathSync(join(root, "apps/desktop/node_modules/@openuidev/react-headless"));
  const headlessRequire = createRequire(join(headless, "package.json"));
  const { EventType } = headlessRequire("@ag-ui/core");
  for (const name of ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"])
    assert.equal(EventType[name], name);
});
