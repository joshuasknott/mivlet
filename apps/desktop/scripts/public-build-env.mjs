// Only public deployment coordinates may be copied from the private local file.
const packagedKeys = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "AUTH_BROKER_URL",
  "CLERK_ISSUER",
  "CLERK_OAUTH_CLIENT_ID",
  "CLERK_AUDIENCE",
  "CLERK_AUTHORIZED_PARTY",
  "CLERK_SCOPES",
  "CLERK_ACCOUNT_ENTRY_URL",
  "CONVEX_URL",
];

export function publicBuildEnvironment(inherited, local) {
  const environment = { ...inherited };
  for (const suffix of packagedKeys) {
    const current = `MIVLET_${suffix}`;
    const legacy = `FABLE_${suffix}`;
    if (Object.hasOwn(local, current)) environment[current] = local[current];
    else if (Object.hasOwn(local, legacy)) environment[current] = local[legacy];
    if (Object.hasOwn(local, legacy)) environment[legacy] = local[legacy];
  }
  return environment;
}
