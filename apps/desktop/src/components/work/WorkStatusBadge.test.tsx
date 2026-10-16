import { describe, expect, it } from "vitest";
import { workPresentation } from "./WorkStatusBadge";
describe("truthful work states", () => {
  it("keeps approval, blockage, user input and interruption distinct", () => {
    expect(workPresentation({ status: "awaiting-approval" }).state).toBe("awaiting-approval");
    expect(workPresentation({ status: "blocked" }).state).toBe("blocked");
    expect(workPresentation({ status: "awaiting-user" }).state).toBe("waiting-for-user");
    expect(workPresentation({ status: "awaiting-user", reason: "The app stopped during this work. Review results." }).state).toBe("interrupted");
    expect(workPresentation({ status: "failed", reason: "The app stopped during this work." }).state).toBe("failed");
    expect(workPresentation({ status: "cancelled" }).label).toBe("Cancelled");
  });
  it("never labels an executing scheduled request as merely scheduled", () => {
    expect(workPresentation({ status: "queued", origin: "schedule" }).state).toBe("scheduled");
    expect(workPresentation({ status: "running", origin: "schedule" }).state).toBe("working");
  });
});
