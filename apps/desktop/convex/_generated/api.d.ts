/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as authorization from "../authorization.js";
import type * as clerkAuthPolicy from "../clerkAuthPolicy.js";
import type * as convexAuth from "../convexAuth.js";
import type * as device from "../device.js";
import type * as executionCapabilityMintRate from "../executionCapabilityMintRate.js";
import type * as hostedExecution from "../hostedExecution.js";
import type * as hostedExecutionPolicy from "../hostedExecutionPolicy.js";
import type * as hostedTasks from "../hostedTasks.js";
import type * as http from "../http.js";
import type * as workspace from "../workspace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  authorization: typeof authorization;
  clerkAuthPolicy: typeof clerkAuthPolicy;
  convexAuth: typeof convexAuth;
  device: typeof device;
  executionCapabilityMintRate: typeof executionCapabilityMintRate;
  hostedExecution: typeof hostedExecution;
  hostedExecutionPolicy: typeof hostedExecutionPolicy;
  hostedTasks: typeof hostedTasks;
  http: typeof http;
  workspace: typeof workspace;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
