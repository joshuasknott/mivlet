import { expect, it } from "vitest";
import { nativeCommandResult } from "./native-command-result";
it("discovers only bounded valid start receipts without trusting arbitrary text or preview URLs", () => {
  const job = { id: "a".repeat(48), generation: 4 };
  expect(nativeCommandResult("repository-start", JSON.stringify({ job }))).toEqual(job);
  expect(nativeCommandResult("read-file", JSON.stringify({ job }))).toBeNull();
  expect(nativeCommandResult("workspace-start", JSON.stringify({ job: { ...job, generation: -1 } }))).toBeNull();
  expect(nativeCommandResult("repository-start", "http://localhost:4173")).toBeNull();
  expect(nativeCommandResult("repository-start", "x".repeat(131073))).toBeNull();
});
