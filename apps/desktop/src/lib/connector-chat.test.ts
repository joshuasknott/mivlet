import { describe, expect, it } from "vitest";
import type { ConnectorManifest } from "@fable/protocol";
import {
  chatConnectorIds,
  chatConnectorTools,
} from "./connector-chat";
import { buildAgentRequest } from "./agent-run";

const manifests = [
  { id: "google-drive", status: "connected" },
  { id: "gmail", status: "connected" },
  { id: "github", status: "needs-auth" },
] as ConnectorManifest[];
describe("chat connector access", () => {
  it("offers supported writes only for selected connected native apps", () => {
    const manifests = [{ id: "gmail", status: "connected", supportedActions: ["gmail.send"] }, { id: "google-drive", status: "connected", supportedActions: ["google-drive.delete-file"] }] as ConnectorManifest[];
    const tools = chatConnectorTools(["gmail"], manifests);
    const action = tools.find((tool) => tool.name === "connector-action");
    expect(action?.description).toContain("Available actions: gmail.send.");
    expect(action?.description).not.toContain("google-drive.delete-file");
    expect(chatConnectorTools([], manifests)).toEqual([]);
  });
  it("makes connected apps available across conversations without agent assignment", () => {
    expect(
      chatConnectorIds([], manifests),
    ).toEqual(["google-drive", "gmail"]);
  });
  it("advertises tools for all connected workspace apps", () => {
    const tools = chatConnectorTools(
      chatConnectorIds([], manifests),
    );
    expect(tools.map((tool) => tool.name)).toEqual(["google-drive-read", "gmail-read"]);
    expect(
      buildAgentRequest({ model: "test", prompt: "Drive", tools }).tools,
    ).toEqual(tools);
    expect(chatConnectorTools([])).toEqual([]);
  });
  it("shares only verified remote connections and excludes saved incomplete apps", () => {
    const native = [{ id: "notion", status: "connected", connectionRoute: "remote" }, { id: "canva", status: "needs-auth", connectionRoute: "remote" }] as ConnectorManifest[];
    const ids = chatConnectorIds(["notion", "canva"], native);
    expect(ids).toEqual(["notion"]);
    expect(chatConnectorTools(ids, native).map((tool) => tool.name)).toEqual(["connector-tools", "connector-call"]);
    expect(chatConnectorIds(["canva"], [{ id: "canva", status: "needs-auth" }] as ConnectorManifest[])).toEqual([]);
    expect(chatConnectorTools(["notion"], [{ id: "notion", status: "connected" }] as ConnectorManifest[]).map((tool) => tool.name)).toEqual(["search-notion"]);
  });
});
