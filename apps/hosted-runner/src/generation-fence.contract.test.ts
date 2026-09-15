import { describe, expect, it } from "vitest";
import { authorizeCapabilityRequest } from "./request-auth";
import {
  MemoryNonceStore,
  createHostedRunnerHarness
} from "./testing/worker-harness";

describe("hosted-runner generation fence contract", () => {
  it("rejects a capability authorized at generation N when the worker generation is N+1", async () => {
    const authorizedGeneration = 3;
    const harness = createHostedRunnerHarness({ generation: authorizedGeneration + 1 });
    const token = await harness.signCapability({
      generation: authorizedGeneration,
      scopes: ["process:launch"]
    });
    const request = harness.processLaunchRequest(token);

    await expect(authorizeCapabilityRequest(
      request,
      harness.signingKey,
      harness.computerId,
      "process:launch",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: true, expectedGeneration: authorizedGeneration });

    const response = await harness.fetch(request);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "capability-stale" });
    expect(harness.computer.launches).toEqual([]);
    expect(harness.computer.consumedNonces.size).toBe(0);
  });
});
