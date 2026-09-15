import { describe, expect, it } from "vitest";
import {
  BROWSER_SCOPES,
  PROCESS_SCOPES,
  createHostedRunnerHarness,
  jsonRequest
} from "./testing/worker-harness";

describe("hosted-runner fetch router", () => {
  it("serves health without credentials", async () => {
    const harness = createHostedRunnerHarness();
    const response = await harness.fetch(new Request("https://runner.example/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "fable-hosted-runner"
    });
  });

  it("rejects missing and invalid credentials with 401", async () => {
    const harness = createHostedRunnerHarness();
    const computerUrl = `https://runner.example/v1/computers/${harness.computerId}`;
    const unauthenticated = await harness.fetch(new Request(computerUrl));
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ error: "unauthorized" });

    const invalid = await harness.fetch(new Request(computerUrl, {
      headers: { Authorization: "Bearer not-the-service-key" }
    }));
    expect(invalid.status).toBe(401);
    expect(harness.computer.statusCalls).toBe(0);
  });

  it("refuses an effect when the capability generation does not match the worker", async () => {
    const harness = createHostedRunnerHarness({ generation: 4 });
    const token = await harness.signCapability({ generation: 3, scopes: ["process:launch"] });
    const response = await harness.fetch(harness.processLaunchRequest(token));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "capability-stale" });
    expect(harness.computer.launches).toEqual([]);
    expect(harness.computer.consumedNonces.size).toBe(0);
  });

  it("keeps process and browser routes on their own capability scopes", async () => {
    const harness = createHostedRunnerHarness({ generation: 3 });
    const processToken = await harness.signCapability({ scopes: ["process:launch"] });
    const browserToken = await harness.signCapability({ scopes: ["browser:navigate"] });
    const snapshotToken = await harness.signCapability({ scopes: ["browser:snapshot"] });

    const launch = await harness.fetch(harness.processLaunchRequest(processToken));
    expect(launch.status).toBe(202);
    expect(harness.computer.launches).toHaveLength(1);
    expect(harness.browser.navigates).toHaveLength(0);

    const processOnBrowser = await harness.fetch(harness.browserNavigateRequest(processToken));
    expect(processOnBrowser.status).toBe(401);
    expect(harness.browser.navigates).toHaveLength(0);

    const browserOnProcess = await harness.fetch(harness.processLaunchRequest(browserToken));
    expect(browserOnProcess.status).toBe(401);
    expect(harness.computer.launches).toHaveLength(1);

    const navigate = await harness.fetch(harness.browserNavigateRequest(browserToken));
    expect(navigate.status).toBe(200);
    expect(harness.browser.navigates).toEqual([
      {
        request: { requestKey: "browser:request-123", url: "https://example.com/path" },
        generation: 3
      }
    ]);
    expect(harness.computer.readyChecks).toEqual([3]);

    const snapshotOnNavigate = await harness.fetch(harness.browserNavigateRequest(snapshotToken));
    expect(snapshotOnNavigate.status).toBe(401);
    expect(harness.browser.navigates).toHaveLength(1);

    const snapshot = await harness.fetch(harness.browserSnapshotRequest(snapshotToken));
    expect(snapshot.status).toBe(200);
    expect(harness.browser.snapshots).toEqual([3]);
    expect(harness.computer.launches).toHaveLength(1);
  });

  it("accepts the capability header for ops but not as a service credential", async () => {
    const harness = createHostedRunnerHarness({ generation: 3 });
    const token = await harness.signCapability({ scopes: PROCESS_SCOPES });
    const launch = await harness.fetch(harness.processLaunchRequest(token));
    expect(launch.status).toBe(202);
    expect(harness.computer.launches).toHaveLength(1);

    const capabilityOnEnsure = await harness.fetch(jsonRequest(
      "PUT",
      `/v1/computers/${harness.computerId}`,
      harness.capabilityHeaders(token)
    ));
    expect(capabilityOnEnsure.status).toBe(401);
    expect(harness.computer.ensureCalls).toBe(0);

    const bearerOnLaunch = await harness.fetch(jsonRequest(
      "POST",
      `/v1/computers/${harness.computerId}/processes`,
      harness.serviceHeaders(),
      { requestKey: "request:run-123:1", runId: "run-123", argv: ["node", "--version"] }
    ));
    expect(bearerOnLaunch.status).toBe(401);
    expect(harness.computer.launches).toHaveLength(1);

    const bearerOnEnsure = await harness.fetch(jsonRequest(
      "PUT",
      `/v1/computers/${harness.computerId}`,
      harness.serviceHeaders()
    ));
    expect(bearerOnEnsure.status).toBe(200);
    expect(harness.computer.ensureCalls).toBe(1);

    const browserToken = await harness.signCapability({ scopes: BROWSER_SCOPES });
    const statusWithCapability = await harness.fetch(new Request(
      `https://runner.example/v1/computers/${harness.computerId}`,
      { headers: harness.capabilityHeaders(browserToken) }
    ));
    expect(statusWithCapability.status).toBe(401);
    expect(harness.computer.statusCalls).toBe(0);
  });
});
