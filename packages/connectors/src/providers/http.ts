import type { ConnectorError, ConnectorId, ConnectorPage, ConnectorTokenSet } from "@fable/protocol";

export interface ProviderHttpRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ProviderHttpClient {
  constructor(
    private readonly connectorId: ConnectorId,
    private readonly baseUrl: string,
    private readonly fetcher: ProviderFetch = fetch
  ) {}

  async request<T>(request: ProviderHttpRequest, tokens: ConnectorTokenSet): Promise<{ data: T; headers: Headers }> {
    const url = new URL(request.path, this.baseUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: request.method ?? "GET",
        signal: request.signal,
        headers: {
          authorization: `${tokens.tokenType || "Bearer"} ${tokens.accessToken}`,
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      throw providerError(this.connectorId, "provider-unavailable", "The provider network request failed.", true);
    }
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    if (!response.ok) {
      let providerCode = "";
      try {
        const value = (await response.json()) as Record<string, unknown>;
        providerCode = String(value.code ?? value.error ?? value.error_description ?? "");
      } catch { /* Never expose raw provider bodies. */ }
      throw statusError(this.connectorId, response.status, providerCode, retryAfter);
    }
    try {
      return { data: (await response.json()) as T, headers: response.headers };
    } catch {
      throw providerError(this.connectorId, "provider-unavailable", "The provider returned malformed JSON.", true);
    }
  }
}

export function page<T>(items: T[], nextCursor?: string, headers?: Headers): ConnectorPage<T> {
  const retryAfter = headers?.get("retry-after");
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
    ...((retryAfter || headers?.get("x-ratelimit-remaining")) ? {
      rateLimit: {
        ...(headers?.get("x-ratelimit-remaining") ? { remaining: Number(headers.get("x-ratelimit-remaining")) } : {}),
        ...(retryAfter ? { retryAfterMs: Number(retryAfter) * 1000 } : {})
      }
    } : {})
  };
}

function statusError(connectorId: ConnectorId, status: number, providerCode: string, retryAfter?: string): ConnectorError {
  const code = status === 401 ? "expired-auth"
    : status === 403 ? "permission-denied"
    : status === 404 ? "not-found"
    : status === 429 ? "rate-limited"
    : status >= 500 ? "provider-unavailable"
    : "invalid-request";
  const suffix = providerCode.includes("missing_scope") ? " The installed app is missing a required scope." : "";
  return providerError(connectorId, code, `The provider rejected the request.${suffix}`, status === 429 || status >= 500, retryAfter);
}

function providerError(connectorId: ConnectorId, code: ConnectorError["code"], message: string, retryable: boolean, retryAfter?: string): ConnectorError {
  return { connectorId, code, message, retryable, ...(retryAfter ? { retryAfter } : {}) };
}
