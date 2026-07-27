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
import type * as cloudPolicy from "../cloudPolicy.js";
import type * as convexAuth from "../convexAuth.js";
import type * as device from "../device.js";
import type * as invitationRecipient from "../invitationRecipient.js";
import type * as membership from "../membership.js";
import type * as mutations from "../mutations.js";
import type * as viewer from "../viewer.js";
import type * as workspace from "../workspace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  authorization: typeof authorization;
  cloudPolicy: typeof cloudPolicy;
  convexAuth: typeof convexAuth;
  device: typeof device;
  invitationRecipient: typeof invitationRecipient;
  membership: typeof membership;
  mutations: typeof mutations;
  viewer: typeof viewer;
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
