import { describe, expect, it } from "@effect/vitest";

import {
  createLfJsonlDecoder,
  JsonlParseFailure,
  parseJsonlLine,
  serializeJsonlLine,
} from "./piJsonl.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR — legal inside JSON
// string payloads but NOT record delimiters. Built from code points so the
// source bytes are unambiguous.
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);

describe("createLfJsonlDecoder", () => {
  it("splits records on LF only", () => {
    const decoder = createLfJsonlDecoder();
    const lines = decoder.push(encode('{"a":1}\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(decoder.flush()).toEqual([]);
  });

  it("does NOT split on raw U+2028 / U+2029 bytes inside a JSON string payload", () => {
    const text = `first${LS}second${PS}third`;
    // Hand-build a frame carrying the RAW separators on the wire, LF-terminated.
    const rawFrame = `{"text":"${text}"}\n`;
    const decoder = createLfJsonlDecoder();
    const lines = decoder.push(encode(rawFrame));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { text: string };
    expect(parsed.text).toBe(text);
  });

  it("buffers a partial line until the terminating LF arrives", () => {
    const decoder = createLfJsonlDecoder();
    expect(decoder.push(encode('{"a"'))).toEqual([]);
    expect(decoder.push(encode(":1}"))).toEqual([]);
    expect(decoder.push(encode("\n"))).toEqual(['{"a":1}']);
  });

  it("handles a multi-byte UTF-8 sequence split across chunk boundaries", () => {
    const full = encode('{"emoji":"😀"}\n');
    const splitAt = 12; // mid-way through the 4-byte emoji
    const decoder = createLfJsonlDecoder();
    expect(decoder.push(full.subarray(0, splitAt))).toEqual([]);
    const lines = decoder.push(full.subarray(splitAt));
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { emoji: string }).emoji).toBe("😀");
  });

  it("surfaces a trailing unterminated line via flush", () => {
    const decoder = createLfJsonlDecoder();
    expect(decoder.push(encode('{"a":1}'))).toEqual([]);
    expect(decoder.flush()).toEqual(['{"a":1}']);
  });

  it("preserves lone carriage returns instead of treating them as framing", () => {
    const decoder = createLfJsonlDecoder();
    const raw = '{"a":"x\ry"}';
    const lines = decoder.push(encode(`${raw}\n`));
    expect(lines).toEqual([raw]);
    // A raw CR is not legal inside a JSON string; framing preserves it and
    // lets the parser report the malformed record rather than splitting it.
    expect(parseJsonlLine(lines[0]!)).toBe(JsonlParseFailure);
  });
});

describe("parseJsonlLine", () => {
  it("returns undefined for blank/whitespace lines", () => {
    expect(parseJsonlLine("")).toBeUndefined();
    expect(parseJsonlLine("   ")).toBeUndefined();
  });

  it("returns the parsed value for valid JSON", () => {
    expect(parseJsonlLine('{"type":"agent_start"}')).toEqual({ type: "agent_start" });
  });

  it("returns the failure sentinel for malformed JSON", () => {
    expect(parseJsonlLine("{not json")).toBe(JsonlParseFailure);
  });
});

describe("serializeJsonlLine", () => {
  it("terminates with exactly one LF and no interior LF", () => {
    const line = serializeJsonlLine({ text: `a${LS}b\nc` });
    expect(line.endsWith("\n")).toBe(true);
    // The only LF is the trailing delimiter; the interior newline in the
    // payload is escaped by JSON.stringify.
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  it("round-trips a payload carrying raw U+2028 / U+2029 through the decoder", () => {
    const value = { text: `a${LS}b${PS}c` };
    const decoder = createLfJsonlDecoder();
    const lines = decoder.push(encode(serializeJsonlLine(value)));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(value);
  });
});
