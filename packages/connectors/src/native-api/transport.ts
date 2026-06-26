/**
 * The injectable HTTP-transport seam for the native-API agent loop.
 *
 * Production injects a transport whose `stream` delegates the actual HTTP/SSE
 * call to the Rust boundary (Rust owns the API key + egress). Tests inject a
 * FixtureTransport that replays recorded responses. The loop itself never
 * touches the network or the key directly — keeping it pure and fixture-testable.
 *
 * This module is browser-safe (no Node built-ins). Reading fixture files from
 * disk happens in the test-only `fixtures-loader` helper, imported only by tests
 * so the Node `fs` import never enters the desktop browser bundle.
 */

/** A request the loop wants sent. `body` is the provider-shaped JSON; the URL
 *  and Authorization header are added by the transport (Rust, in production). */
export interface NativeTransportRequest {
  providerId: string;
  model: string;
  /** The provider-specific request body, already shaped by the shaper. */
  body: unknown;
}

/** An async iterator of raw SSE lines (blank lines dropped). */
export interface HttpTransport {
  stream(request: NativeTransportRequest): AsyncIterable<string>;
}

/** A transport that replays a fixed list of SSE lines (blank lines dropped). */
export class FixtureTransport implements HttpTransport {
  private readonly lines: readonly string[];

  constructor(lines: readonly string[]) {
    this.lines = lines;
  }

  /** Build a FixtureTransport from a recorded fixture text (lines split on \n). */
  static fromText(text: string): FixtureTransport {
    return new FixtureTransport(text.split(/\r?\n/));
  }

  async *stream(_request: NativeTransportRequest): AsyncIterable<string> {
    for (const line of this.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      yield trimmed;
    }
  }
}
