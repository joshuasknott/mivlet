// An actual official SDK client against Rust's production router. The Rust test
// supplies an isolated native store and approves consent through the same native
// function as Settings. No test endpoint or credential bypass exists in the server.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const url = new URL(process.argv[2]);
assert.equal(url.hostname, "127.0.0.1");
let tokens, clientInformation, verifier, authorizationCode, state;
const provider = {
  get redirectUrl() {
    return "http://127.0.0.1:40101/callback";
  },
  get clientMetadata() {
    return {
      client_name: "Official SDK acceptance",
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "mivlet:read mivlet:tasks",
    };
  },
  clientInformation: () => clientInformation,
  saveClientInformation: (value) => {
    clientInformation = value;
  },
  tokens: () => tokens,
  saveTokens: (value) => {
    tokens = value;
  },
  saveCodeVerifier: (value) => {
    verifier = value;
  },
  codeVerifier: () => verifier,
  state: () => (state ??= crypto.randomUUID()),
  redirectToAuthorization: async (authorizationUrl) => {
    assert.equal(authorizationUrl.origin, url.origin);
    let response = await fetch(authorizationUrl, { redirect: "manual" });
    assert.equal(response.status, 303);
    const wait = new URL(response.headers.get("location"), url);
    for (let attempt = 0; attempt < 100; attempt++) {
      response = await fetch(wait, { redirect: "manual" });
      if (response.status === 303) {
        const result = new URL(response.headers.get("location"));
        assert.equal(result.origin, new URL(provider.redirectUrl).origin);
        assert.equal(result.searchParams.get("state"), state);
        assert.equal(result.searchParams.get("iss"), url.origin);
        authorizationCode = result.searchParams.get("code");
        return;
      }
      assert.equal(response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Native consent did not arrive");
  },
};
const transport = new StreamableHTTPClientTransport(url, {
  authProvider: provider,
});
const client = new Client({ name: "mivlet-acceptance", version: "1" });
// Explicit opt-in to task scopes. Ordinary unauthenticated discovery challenges
// with read-only access; production consent still defaults to read-only.
assert.equal(
  await auth(provider, { serverUrl: url, scope: "mivlet:read mivlet:tasks" }),
  "REDIRECT",
);
assert.ok(authorizationCode);
assert.equal(
  await auth(provider, {
    serverUrl: url,
    authorizationCode,
    scope: "mivlet:read mivlet:tasks",
  }),
  "AUTHORIZED",
);
await client.connect(transport);
try {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 6);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.structuredContent;
  };
  const agents = await call("mivlet_agents", { workspaceId: "default" });
  assert.equal(agents.agents.length, 1);
  const args = {
    workspaceId: "default",
    agentId: "agent-one",
    requestId: "sdk-request-1",
    text: "SDK test task",
  };
  const task = await call("mivlet_request_task", args);
  assert.equal(task.status, "queued");
  assert.deepEqual(await call("mivlet_request_task", args), task);
  await call("mivlet_message_work", {
    workspaceId: "default",
    agentId: "agent-one",
    workId: task.id,
    expectedGeneration: task.generation,
    requestId: "sdk-message-1",
    text: "Untrusted follow-up",
  });
  const stop = {
    workspaceId: "default",
    agentId: "agent-one",
    workId: task.id,
    expectedGeneration: task.generation,
    requestId: "sdk-stop-1",
  };
  const stopped = await call("mivlet_stop_work", stop);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.generation, task.generation + 1);
  assert.deepEqual(await call("mivlet_stop_work", stop), stopped);
  const current = await call("mivlet_read_work", {
    workspaceId: "default",
    agentId: "agent-one",
    workId: task.id,
  });
  assert.equal(current.status, "cancelled");
  assert.equal(current.generation, stopped.generation);
  console.log("official MCP client passed");
} finally {
  await client.close();
}
