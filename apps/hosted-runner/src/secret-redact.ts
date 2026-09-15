const SECRET_MARKERS = [
  /\bsk-ant-[a-zA-Z0-9_\-]{20,}\b/g,
  /\bsk-[a-zA-Z0-9_\-]{20,}\b/g,
  /\bAIzaSy[a-zA-Z0-9_\-]{33}\b/g,
  /\bBearer\s+[a-zA-Z0-9\-._~+/]{10,}(?:=*)?\b/gi,
  /(\b(?:api[-_]?key|token|password|cookie|authorization|secret|credential)\s*(?:[=:]|:\s*)\s*(["']?))([a-zA-Z0-9\-._~+/%=]{6,})(\2)/gi
];

const SURVIVING_SECRET = /sk-ant-|sk-[a-zA-Z0-9_\-]{16,}|AIzaSy|Bearer\s+[A-Za-z0-9]|ghp_|github_pat_/i;

export function redactHostedProcessOutput(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let redacted = value;
  for (const pattern of SECRET_MARKERS) {
    redacted = redacted.replace(pattern, (match, keyPrefix?: string, quote?: string, _secret?: string, closing?: string) => {
      if (typeof keyPrefix === "string") return `${keyPrefix}[REDACTED]${closing ?? ""}`;
      if (match.toLowerCase().startsWith("bearer")) return "Bearer [REDACTED]";
      return "[REDACTED]";
    });
  }
  if (SURVIVING_SECRET.test(redacted)) {
    return "[output omitted: secret-shaped content]";
  }
  return redacted;
}
