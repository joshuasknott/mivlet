export default {
  providers: [
    {
      domain: process.env.FABLE_CLERK_ISSUER ?? "https://mock-clerk.fable.local",
      applicationID: process.env.FABLE_CLERK_AUDIENCE ?? "fable-convex-test"
    }
  ]
};
