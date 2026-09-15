export function nextEnsureGeneration(previousGeneration: number | undefined): number {
  return previousGeneration === undefined ? 1 : previousGeneration + 1;
}

export function isUniqueConstraintFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unique constraint failed/i.test(error.message) || /SQLITE_CONSTRAINT/i.test(error.message);
}

export function consumeCapabilityNonceRecord(
  exec: (query: string, ...params: Array<ArrayBuffer | string | number | null>) => void,
  nonce: string,
  expiresAt: number,
  now: number
): void {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(nonce)) {
    throw operationCode("capability-stale");
  }
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now) || expiresAt <= now) {
    throw operationCode("capability-stale");
  }
  try {
    exec("DELETE FROM consumed_nonces WHERE expires_at <= ?", now);
    exec(
      "INSERT INTO consumed_nonces (nonce, expires_at, consumed_at) VALUES (?, ?, ?)",
      nonce,
      expiresAt,
      now
    );
  } catch (error) {
    if (isUniqueConstraintFailure(error)) throw operationCode("capability-replayed");
    throw operationCode("capability-store-unavailable", error);
  }
}

function operationCode(code: string, cause?: unknown): Error {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.name = "HostedComputerOperationError";
  return error;
}
