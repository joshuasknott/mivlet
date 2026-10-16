import { afterEach, expect, it } from "vitest";
import { clearActiveRuntimeDataScope, getActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";

afterEach(clearActiveRuntimeDataScope);
it("retains the verified scope on revalidation and replaces it on owner/workspace/session changes", () => {
  const first = setActiveRuntimeDataScope("workspace", "owner-a");
  expect(setActiveRuntimeDataScope("workspace", "owner-a")).toBe(first);
  expect(getActiveRuntimeDataScope()).toBe(first);
  const otherOwner = setActiveRuntimeDataScope("workspace", "owner-b");
  expect(otherOwner).not.toBe(first);
  expect(setActiveRuntimeDataScope("other", "owner-b")).not.toBe(otherOwner);
  clearActiveRuntimeDataScope();
  expect(setActiveRuntimeDataScope("workspace", "owner-a")).not.toBe(first);
});
it("preserves explicit one-argument resets used by transient attachment scopes", () => {
  const first = setActiveRuntimeDataScope("workspace");
  expect(setActiveRuntimeDataScope("workspace")).not.toBe(first);
});
