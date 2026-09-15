import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { getComputer, requestExecutionCapability, requestProvision } from "./hostedExecution";

type ConvexFunctionVisibility = {
  isAction?: boolean;
  isInternal?: boolean;
  isMutation?: boolean;
  isQuery?: boolean;
};

function visibility(value: unknown): ConvexFunctionVisibility {
  return (value ?? {}) as ConvexFunctionVisibility;
}

function isPublicClientFunction(value: unknown): boolean {
  const fn = visibility(value);
  return Boolean(fn.isQuery || fn.isMutation || fn.isAction) && fn.isInternal !== true;
}

describe("hosted execution capability minting", () => {
  it("keeps capability minting off the public Convex client path", () => {
    expect(visibility(requestExecutionCapability).isAction).toBe(true);
    expect(visibility(requestExecutionCapability).isInternal).toBe(true);
    expect(isPublicClientFunction(requestExecutionCapability)).toBe(false);
    expect(isPublicClientFunction(requestProvision)).toBe(true);
    expect(isPublicClientFunction(getComputer)).toBe(true);
  });

  it("exposes minting only on the internal function table", () => {
    type PublicHosted = typeof api.hostedExecution;
    type InternalHosted = typeof internal.hostedExecution;
    type PublicMint = PublicHosted extends { requestExecutionCapability: unknown } ? true : false;
    type InternalMint = InternalHosted extends { requestExecutionCapability: unknown } ? true : false;
    const publicClientCannotMint: PublicMint = false;
    const internalCanMint: InternalMint = true;
    expect(publicClientCannotMint).toBe(false);
    expect(internalCanMint).toBe(true);
    // @ts-expect-error public Convex clients cannot mint hosted capabilities
    void api.hostedExecution.requestExecutionCapability;
  });
});
