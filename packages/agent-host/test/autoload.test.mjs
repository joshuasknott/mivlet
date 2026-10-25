import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentHostProcess } from "./support/host-process.mjs";
import { test } from "./support/windows-host.mjs";

test("host does not autoload dotenv or bunfig from its working directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mivlet-agent-host-autoload-test-"));
  const marker = join(directory, "bunfig-preloaded");
  writeFileSync(join(directory, ".env"), "MIVLET_MCP_REQUEST_TIMEOUT_MS=100\nMIVLET_HOST_AUTOLOAD_CANARY=fixture\n");
  writeFileSync(join(directory, "bunfig.toml"), 'preload = ["./bunfig-preload.mjs"]\n');
  writeFileSync(join(directory, "bunfig-preload.mjs"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, process.env.MIVLET_HOST_AUTOLOAD_CANARY ?? "missing");
  `);

  const host = new AgentHostProcess(["--mcp"], {}, { directory });
  try {
    host.write({ type: "request", id: 1, method: "initialize" });
    await host.nextType("send");
    await assert.rejects(
      host.next((event) => event.type === "send" && event.frame?.method === "notifications/cancelled", "unexpected dotenv timeout", 300),
    );
    assert.equal(existsSync(marker), false, "bunfig preload must not execute");
    host.write({ type: "close" });
    await host.nextType("closed");
    assert.equal((await host.waitForExit()).code, 0);
  } finally {
    await host.dispose();
  }
});
