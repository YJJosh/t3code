/**
 * Strict LF-delimited JSONL framing for the Pi RPC transport.
 *
 * Pi's RPC protocol frames records with `\n` (U+000A) ONLY. Payload strings
 * may legally contain other Unicode line separators — notably U+2028 (LINE
 * SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) — inside JSON string values.
 * (`JSON.stringify` does not escape these, so they appear raw on the wire.)
 *
 * This is why we cannot use Node's `readline`: readline (and `String#split`
 * on `/\r?\n/` variants that many libraries reach for) treat additional
 * Unicode separators as line boundaries, which would split a single JSON
 * record into two and corrupt the stream. The decoder below splits on `\n`
 * and nothing else, so U+2028 / U+2029 pass through untouched.
 *
 * The decoder is a pure, incremental state machine over UTF-8 byte chunks so
 * it composes with Effect's `Stream<Uint8Array>` process stdout without any
 * platform I/O. Multi-byte UTF-8 sequences split across chunk boundaries are
 * handled by the streaming `TextDecoder`.
 *
 * @module provider/pi/piJsonl
 */

/**
 * Incremental UTF-8 → LF-framed line decoder.
 *
 * Feed raw stdout chunks to {@link push}; it returns the complete lines that
 * became available (each with its trailing `\n` stripped, `\r` preserved —
 * Pi never emits CRLF, and stripping a lone `\r` inside a payload would be
 * wrong). Call {@link flush} when the stream ends to surface any trailing
 * partial line that lacked a terminating newline.
 */
export interface LfJsonlDecoder {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<string>;
  readonly flush: () => ReadonlyArray<string>;
}

export function createLfJsonlDecoder(): LfJsonlDecoder {
  // `fatal: false` so a malformed byte becomes U+FFFD rather than throwing —
  // a corrupt frame is surfaced as a parse failure downstream, not a crash.
  const textDecoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";

  const drainCompleteLines = (): string[] => {
    const lines: string[] = [];
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      lines.push(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
    return lines;
  };

  return {
    push: (chunk) => {
      buffer += textDecoder.decode(chunk, { stream: true });
      return drainCompleteLines();
    },
    flush: () => {
      // Flush any bytes still held by the streaming decoder (a truncated
      // multi-byte sequence surfaces as U+FFFD here).
      buffer += textDecoder.decode();
      const remaining = buffer;
      buffer = "";
      return remaining.length > 0 ? [remaining] : [];
    },
  };
}

/**
 * Parse one JSONL frame. Blank lines (Pi may emit them as keep-alives) yield
 * `undefined`; malformed JSON yields the {@link JsonlParseFailure} sentinel so
 * callers can log/emit a typed warning instead of crashing the pump.
 */
export const JsonlParseFailure = Symbol.for("t3/pi/JsonlParseFailure");
export type JsonlParseFailure = typeof JsonlParseFailure;

export function parseJsonlLine(line: string): unknown | undefined | JsonlParseFailure {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return JsonlParseFailure;
  }
}

/**
 * Serialize one command as a strict LF-terminated JSONL frame.
 *
 * `JSON.stringify` does NOT escape U+2028 / U+2029 (they are legal raw in
 * JSON), so the payload may carry those separators verbatim — which is exactly
 * why the reader must split on `\n` only. The single trailing `\n` is the sole
 * record delimiter, and `JSON.stringify` never emits an interior `\n` (it
 * escapes those inside strings).
 */
export function serializeJsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
