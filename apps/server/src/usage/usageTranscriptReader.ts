// @effect-diagnostics nodeBuiltinImport:off
// Cold windows span ~1.4 GB/1,500 files; node:fs buffer streaming is ~10x cheaper than materializing files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import type { UsageSourceScan } from "@t3tools/contracts";
import type {
  SelectedFields,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { createTranscriptJsonReader } from "../project/AgentSessionJson.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptFileOptions {
  readonly fileName?: string;
  /** Maximum number of directories below the source root; omitted means recursive. */
  readonly maxDepth?: number;
  readonly filePattern?: UsageSourceScan["filePattern"];
}

/** The same selection applies to live files and retained cache entries. */
export function transcriptPathIncluded(
  root: string,
  file: string,
  options?: TranscriptFileOptions,
): boolean {
  const relative = NodePath.relative(root, file);
  if (
    NodePath.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`)
  )
    return false;
  const parts = relative.split(NodePath.sep);
  const depth = parts.length - 1;
  if (options?.maxDepth !== undefined && depth > options.maxDepth) return false;
  if (options?.filePattern === "pi-subagent-session" && (depth !== 2 || parts[1] !== "session"))
    return false;
  const name = parts.at(-1)!;
  return options?.fileName === undefined ? name.endsWith(".jsonl") : name === options.fileName;
}

/** Resume only if bytes before resumeOffset match the guard hash; rewritten files would corrupt totals. */
export interface TranscriptParsePosition {
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly state: unknown;
}

export interface TranscriptParseResult {
  readonly records: readonly UsageRecord[];
  /** Unterminated tail records stay outside records/position so the next scan rereads them. */
  readonly tailRecords: readonly UsageRecord[];
  /** Includes tentative tail diagnostics; position.state only includes committed lines. */
  readonly malformedRecords: number;
  readonly position: TranscriptParsePosition;
  readonly resumed: boolean;
}

export const GUARD_LENGTH = 64;
const STREAMING_THRESHOLD_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const STAT_CONCURRENCY = 32;
const CARRIAGE_RETURN = 0x0d;

function selectUsageFields(fields: SelectedFields) {
  return (path: ReadonlyArray<string | number | null>): boolean => {
    let selected: true | SelectedFields = fields;
    for (const key of path) {
      if (selected === true) return true;
      // Array indexes select by their string form, like `{ content: { 0: ... } }`.
      const name = typeof key === "number" ? String(key) : key;
      if (name === null || !Object.hasOwn(selected, name)) return false;
      selected = selected[name]!;
    }
    return true;
  };
}

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Skips Grok logs without usage; preserves readdir order for first-seen deduplication. */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: TranscriptFileOptions,
): Promise<{
  readonly files: readonly TranscriptFile[];
  readonly failedPaths: number;
  readonly unreadableDirectories: number;
}> {
  const candidates: string[] = [];
  let failedPaths = 0;
  let unreadableDirectories = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      failedPaths += 1;
      unreadableDirectories += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        const withinDepth = options?.maxDepth === undefined || depth < options.maxDepth;
        const withinPattern =
          options?.filePattern !== "pi-subagent-session" ||
          depth === 0 ||
          (depth === 1 && entry.name === "session");
        if (withinDepth && withinPattern) await walk(child, depth + 1);
      } else if (transcriptPathIncluded(root, child, options)) {
        candidates.push(child);
      }
    }
  };
  await walk(root, 0);

  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  const queue = candidates.entries();
  const statQueued = async (): Promise<void> => {
    for (const [index, path] of queue) {
      try {
        const stats = await NodeFSP.stat(path);
        if (stats.mtimeMs >= sinceMs) {
          found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          failedPaths += 1;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued),
  );
  return { files: found.filter((file) => file !== undefined), failedPaths, unreadableDirectories };
}

export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/** Parent identities nearest first, matching the portable containment proof on clients. */
export async function readDirectoryAncestorVolumeIds(path: string): Promise<readonly string[]> {
  const parents: string[] = [];
  let current = NodePath.resolve(path);
  while (true) {
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    parents.push(parent);
    current = parent;
  }
  return Promise.all(parents.map(readDirectoryVolumeId));
}

async function guardMatches(
  handle: NodeFSP.FileHandle,
  position: TranscriptParsePosition,
): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false;
  try {
    const window = Buffer.alloc(position.guardLength);
    const { bytesRead } = await handle.read(
      window,
      0,
      position.guardLength,
      position.resumeOffset - position.guardLength,
    );
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return false;
  }
}

// Match markers in one latin1 alternation; one character per byte preserves exact ASCII offsets.
export function transcriptLineGate(markers: readonly [string, ...string[]]) {
  if (markers.length === 1) {
    const marker = Buffer.from(markers[0]);
    return (line: Buffer) => line.includes(marker);
  }
  const pattern = new RegExp(
    markers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  );
  return (line: Buffer) => pattern.test(line.toString("latin1"));
}

/** Returns null on read failure; caching it as empty would hide usage until size/mtime changes. */
export async function readTranscriptRecords<State>(
  filePath: string,
  format: TranscriptUsageFormat<State>,
  resumeFrom?: TranscriptParsePosition,
  options?: { readonly streamingThresholdBytes?: number },
): Promise<TranscriptParseResult | null> {
  const streamingThresholdBytes = options?.streamingThresholdBytes ?? STREAMING_THRESHOLD_BYTES;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    const codec = format.state;
    const decodeState = codec === undefined ? undefined : Schema.decodeUnknownOption(codec.schema);
    const encodeState = codec === undefined ? undefined : Schema.encodeSync(codec.schema);
    let state = codec === undefined ? (undefined as State) : codec.initial();
    let resumed = false;
    let start = 0;
    const savedState =
      resumeFrom === undefined || decodeState === undefined || resumeFrom.state === null
        ? Option.none()
        : decodeState(resumeFrom.state);
    if (
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (codec === undefined || Option.isSome(savedState)) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (Option.isSome(savedState)) state = savedState.value;
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    const mightCarryUsage = transcriptLineGate(format.usageMarkers);
    const parseLine = (lineBuffer: Buffer, lineState: State, out: UsageRecord[]): void => {
      if (!mightCarryUsage(lineBuffer)) return;
      for (const record of format.parseLine(toLineString(lineBuffer), lineState)) out.push(record);
    };

    const records: UsageRecord[] = [];
    let resumeOffset = start;
    let scanOffset = start;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let streaming: ReturnType<typeof createTranscriptJsonReader> | undefined;
    let decoder: NodeStringDecoder.StringDecoder | undefined;
    const selectPath = selectUsageFields(format.selectFields);

    const append = (segment: Buffer) => {
      if (!streaming && pendingBytes + segment.length <= streamingThresholdBytes) {
        if (segment.length > 0) pendingChunks.push(segment);
        pendingBytes += segment.length;
        return;
      }
      if (!streaming) {
        // Usage has no import-history budget; retain selected fields regardless of surrounding tool payload size.
        streaming = createTranscriptJsonReader(() => {}, selectPath, { maxDepth: Infinity });
        decoder = new NodeStringDecoder.StringDecoder("utf8");
        for (const pending of pendingChunks) streaming.write(decoder.write(pending));
        pendingChunks = [];
        pendingBytes = 0;
      }
      streaming.write(decoder!.write(segment));
    };
    const finish = (lineState: State, out: UsageRecord[]) => {
      if (streaming) {
        streaming.write(decoder!.end());
        const projected = streaming.finish();
        for (const record of format.parseProjected(projected, lineState)) out.push(record);
      } else if (pendingBytes > 0) {
        const line =
          pendingChunks.length === 1
            ? pendingChunks[0]!
            : Buffer.concat(pendingChunks, pendingBytes);
        parseLine(line, lineState, out);
      }
      pendingChunks = [];
      pendingBytes = 0;
      streaming = undefined;
      decoder = undefined;
    };
    const stream = handle.createReadStream({
      start,
      autoClose: false,
      highWaterMark: 256 * 1024,
    }) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newlineIndex = chunk.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) {
          append(chunk.subarray(lineStart));
          break;
        }
        if (!streaming && pendingBytes === 0) {
          parseLine(chunk.subarray(lineStart, newlineIndex), state, records);
        } else {
          append(chunk.subarray(lineStart, newlineIndex));
          finish(state, records);
        }
        lineStart = newlineIndex + 1;
        resumeOffset = scanOffset + lineStart;
      }
      scanOffset += chunk.length;
    }

    // Parse unfinished tails against copied state so the next scan can replay from resumeOffset.
    const encodedState = encodeState === undefined ? null : encodeState(state);
    const tailRecords: UsageRecord[] = [];
    const tailState =
      decodeState === undefined ? state : Option.getOrThrow(decodeState(encodedState));
    finish(tailState, tailRecords);

    const guardLength = Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      tailRecords,
      malformedRecords: format.readMalformedRecords?.(tailState) ?? 0,
      position: {
        resumeOffset,
        guardLength,
        guardHash,
        state: encodedState,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
