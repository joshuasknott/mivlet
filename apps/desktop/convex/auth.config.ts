import { createConvexAuthConfig } from "./clerkAuthPolicy";

export {
  createConvexAuthConfig, isNonLocalClerkMockEnvironment,
  MOCK_CLERK_AUDIENCE, MOCK_CLERK_ISSUER,
  type ConvexAuthConfig, type ConvexAuthProviderConfig,
} from "./clerkAuthPolicy";

// Resolve environment values during module evaluation. Convex serializes the
// result after evaluation, when an environment-reading getter cannot execute.
export default createConvexAuthConfig();
