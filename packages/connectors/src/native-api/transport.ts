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

import type { NativeCompletionRequest } from "@fable/protocol";

/** An async iterator of raw SSE lines (blank lines dropped). The transport
 *  receives the normalized request and shapes it per provider (the API key is
 *  added by the transport in production — Rust — never in the request type). */
export interface HttpTransport {
  stream(request: NativeCompletionRequest): AsyncIterable<string>;
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

  async *stream(_request: NativeCompletionRequest): AsyncIterable<string> {
    for (const line of this.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      yield trimmed;
    }
  }
}

/**
 * A transport that serves a different fixture per `stream()` call, advancing
 * through a sequence. The agent loop calls `stream()` once per turn (each a
 * fresh request in production); this lets multi-turn tests script turn 1, 2, …
 * without re-reading the same lines.
 */
export class SequencedFixtureTransport implements HttpTransport {
  private readonly turns: readonly (readonly string[])[];
  private index = 0;

  constructor(turns: readonly (readonly string[])[]) {
    this.turns = turns;
  }

  /** Build from a sequence of fixture texts (one per turn). */
  static fromTexts(texts: readonly string[]): SequencedFixtureTransport {
    return new SequencedFixtureTransport(texts.map((text) => text.split(/\r?\n/)));
  }

  async *stream(_request: NativeCompletionRequest): AsyncIterable<string> {
    const lines = this.turns[this.index] ?? [];
    this.index += 1;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      yield trimmed;
    }
  }
}
