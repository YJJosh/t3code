/**
 * Pi frames JSONL with LF only; readline can split legal raw U+2028/U+2029 payloads
 * and corrupt records. Streaming TextDecoder preserves UTF-8 across byte chunks.
 */

/**
 * push strips only the framing LF, preserving CR and Unicode separators in payloads.
 * flush surfaces a final partial line even when the stream ends without LF.
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
 * JSON.stringify escapes interior LF but leaves U+2028/U+2029 raw.
 * Only the appended LF delimits the record.
 */
export function serializeJsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
