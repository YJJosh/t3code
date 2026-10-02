// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and buffer-level streaming is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * Transcripts are append-only, so a parse also reports the byte position it
 * stopped at. A later scan of the same file resumes from that position and
 * parses only the appended bytes, which is what keeps a warm scan cheap while a
 * session is actively writing a multi-hundred-megabyte rollout.
 *
 * @module usageTranscriptReader
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import type { UsageProviderKind } from "@t3tools/contracts";

import { createTranscriptJsonReader } from "../project/AgentSessionJson.ts";

import {
  initialCodexScanState,
  initialPiScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseClaudeRecord,
  parseCodexLine,
  parseCodexRecord,
  parseGrokLine,
  parsePiLine,
  type PiScanState,
  parseGrokRecord,
  type CodexScanState,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptFileListing {
  readonly files: readonly TranscriptFile[];
  /** Directories that existed but could not be enumerated during this walk. */
  readonly unreadableDirectories: number;
}

export interface TranscriptFileOptions {
  /** Restricts the walk to one basename (Grok's `updates.jsonl`). */
  readonly fileName?: string;
  /** Maximum directory depth below the root to descend into. */
  readonly maxDepth?: number;
  /**
   * Restricts a Pi subagent runs root to `runs/<run>/session/*.jsonl`.
   * This deliberately excludes the sibling event journal and workflow logs.
   */
  readonly piSubagentSessionsOnly?: boolean;
}

/**
 * Where a parse stopped, with enough state to continue from there.
 *
 * The guard hash fingerprints the bytes immediately before `resumeOffset`. A
 * resume only proceeds when those bytes still match: transcripts are
 * append-only by design, but a rotated or rewritten file silently mis-parsed
 * from the middle would corrupt usage totals. The window is a cheap tripwire
 * for those realistic failure shapes, all of which disturb the file's tail at
 * that exact offset; it deliberately does not hash the whole prefix, which
 * would cost the full re-read the resume exists to avoid.
 */
export interface TranscriptParsePosition {
  /** Byte offset just past the last newline-terminated line consumed. */
  readonly resumeOffset: number;
  /** Length of the fingerprinted window ending at `resumeOffset`. */
  readonly guardLength: number;
  /** FNV-1a hash of that window. */
  readonly guardHash: number;
  /** Codex reducer state as of `resumeOffset`; `null` for other providers. */
  readonly codexState: CodexScanState | null;
  /** Pi session, project and model state as of `resumeOffset`. */
  readonly piState: PiScanState | null;
}

export interface TranscriptParseResult {
  /** Project roots declared by Pi headers, including an unterminated tail header. */
  readonly projectPaths: readonly string[];
  /** Records from newline-terminated lines at or after the parse start. */
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer has not newline-terminated yet.
   * Kept out of `records` because `position` deliberately excludes that
   * segment: the next scan re-reads it once the writer finishes the line.
   */
  readonly tailRecords: readonly UsageRecord[];
  readonly position: TranscriptParsePosition;
  /** Whether the parse continued from `resumeFrom` rather than byte 0. */
  readonly resumed: boolean;
}

/** 64 bytes of JSONL tail is ample to distinguish a replaced file. */
export const GUARD_LENGTH = 64;
// Native parsing is faster for common 1–4 MiB context/tool records. Above
// 8 MiB, project usage without allocating the whole record. This switches
// readers; it never discards a record because of its size.
const STREAMING_THRESHOLD_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

type SelectedFields = { readonly [key: string]: true | SelectedFields };

// Keep the fields consumed by usageTranscripts, including reducer state and
// dedupe/cost metadata. A selected subtree (usage) keeps future token fields.
const USAGE_FIELDS: Record<"claude" | "codex" | "grok" | "pi", SelectedFields> = {
  pi: {
    type: true,
    id: true,
    timestamp: true,
    cwd: true,
    provider: true,
    modelId: true,
    role: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, usage: true, timestamp: true },
  },
  claude: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  codex: {
    type: true,
    timestamp: true,
    payload: {
      type: true,
      id: true,
      session_id: true,
      model: true,
      forked_from_id: true,
      source: { subagent: { thread_spawn: { parent_thread_id: true } } },
      info: { last_token_usage: true },
    },
  },
  grok: {
    timestamp: true,
    params: {
      sessionId: true,
      _meta: { agentTimestampMs: true },
      update: { sessionUpdate: true, prompt_id: true, usage: true },
    },
  },
};

function selectUsageFields(provider: UsageProviderKind) {
  const fields =
    USAGE_FIELDS[
      provider === "codex" || provider === "grok" || provider === "pi" ? provider : "claude"
    ];
  return (path: ReadonlyArray<string | number | null>): boolean => {
    let selected: true | SelectedFields = fields;
    for (const key of path) {
      if (selected === true) return true;
      if (typeof key !== "string" || !Object.hasOwn(selected, key)) return false;
      selected = selected[key]!;
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

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Vanished individual entries are skipped because sessions can rotate during
 * the walk. Unreadable directories are counted so callers can report partial
 * coverage and avoid pruning cache entries from an incomplete listing.
 *
 * `fileName` restricts the walk to a single basename (Grok's `updates.jsonl`).
 * Grok sessions also ship multi-megabyte `chat_history` and `events` logs that
 * never carry usage, so the basename filter keeps a cold scan off those files.
 *
 * Pi's normal session root is at most `<sessions>/<project>/<file>`. Its
 * subagent extension stores transcripts at `runs/<run>/session/<file>` beside
 * large event journals. Callers bound both walks to those layouts rather than
 * recursively treating arbitrary JSONL files as Pi sessions.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: TranscriptFileOptions,
): Promise<TranscriptFileListing> {
  const found: TranscriptFile[] = [];
  let unreadableDirectories = 0;
  const fileName = options?.fileName;

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      unreadableDirectories += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        const isPiSubagentSessionDirectory = depth === 1 && entry.name === "session";
        const mayDescendForPiSubagents =
          !options?.piSubagentSessionsOnly || depth === 0 || isPiSubagentSessionDirectory;
        const mayDescendForDepth = options?.maxDepth === undefined || depth < options.maxDepth;
        if (mayDescendForPiSubagents && mayDescendForDepth) await walk(child, depth + 1);
        continue;
      }
      // A Pi subagent's only transcript is directly inside its run's `session`
      // directory; journals such as `events.v1.jsonl` must never reach the parser.
      if (options?.piSubagentSessionsOnly && depth !== 2) continue;
      if (fileName !== undefined) {
        if (entry.name !== fileName) continue;
      } else if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root, 0);
  return { files: found, unreadableDirectories };
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
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

/**
 * Streams one transcript and returns its usage records plus any Pi project
 * roots, or `null` when the file could not be read. The read-failure distinction
 * matters to the caller's cache: a genuinely empty transcript is a stable fact
 * worth memoising, while a transient read failure memoised under the same
 * `(size, mtime)` key would silently drop that file's usage until it next changes.
 *
 * With `resumeFrom`, parsing continues from that position when its guard bytes
 * still match, so only appended lines are read; otherwise the whole file is
 * re-parsed from the start and `resumed` reports `false`.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, and Pi carries session identity and the active model on `session`
 * and `model_change` lines, so those still have to pass through the reducer to
 * keep attribution correct. Pi candidate files are constrained by the caller;
 * do not relax that filter to parse subagent event journals.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
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
    let codexState = initialCodexScanState();
    let piState = initialPiScanState();
    let resumed = false;
    let start = 0;
    if (
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (provider !== "codex" || resumeFrom.codexState !== null) &&
      (provider !== "pi" || resumeFrom.piState !== null) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (resumeFrom.codexState !== null) codexState = { ...resumeFrom.codexState };
      if (resumeFrom.piState !== null) piState = { ...resumeFrom.piState };
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const parseLine = (
      line: string,
      state: CodexScanState,
      pi: PiScanState,
      out: UsageRecord[],
    ): void => {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          return;
        }
        const record = parseCodexLine(line, state);
        if (record !== null) out.push(record);
        return;
      }
      if (provider === "pi") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"type":"session"') &&
          !line.includes('"type": "session"') &&
          !line.includes('"model_change"')
        ) {
          return;
        }
        const record = parsePiLine(line, pi);
        if (record !== null) out.push(record);
        return;
      }
      if (!mightCarryUsage(line, provider)) return;
      if (provider === "grok") {
        for (const grokRecord of parseGrokLine(line)) out.push(grokRecord);
        return;
      }
      const record = parseClaudeLine(line);
      if (record !== null) out.push(record);
    };

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    const records: UsageRecord[] = [];
    // Byte offsets remain independent of UTF-8 decoding. Only complete lines
    // commit the resume point; an unfinished tail is replayed on the next scan.
    let resumeOffset = start;
    let scanOffset = start;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let streaming: ReturnType<typeof createTranscriptJsonReader> | undefined;
    let decoder: NodeStringDecoder.StringDecoder | undefined;
    const selectPath = selectUsageFields(provider);

    const append = (segment: Buffer) => {
      if (!streaming && pendingBytes + segment.length <= streamingThresholdBytes) {
        if (segment.length > 0) pendingChunks.push(segment);
        pendingBytes += segment.length;
        return;
      }
      if (!streaming) {
        // Usage has no import-history budget: retain all selected usage fields,
        // regardless of the size of the surrounding unselected tool content.
        streaming = createTranscriptJsonReader(() => {}, selectPath, { maxDepth: Infinity });
        decoder = new NodeStringDecoder.StringDecoder("utf8");
        for (const pending of pendingChunks) streaming.write(decoder.write(pending));
        pendingChunks = [];
        pendingBytes = 0;
      }
      streaming.write(decoder!.write(segment));
    };
    const finish = (state: CodexScanState, pi: PiScanState, out: UsageRecord[]) => {
      if (streaming) {
        streaming.write(decoder!.end());
        const projected = streaming.finish();
        if (provider === "pi") {
          const record = parsePiLine(JSON.stringify(projected), pi);
          if (record !== null) out.push(record);
        } else if (provider === "grok") {
          out.push(...parseGrokRecord(projected));
        } else {
          const record =
            provider === "codex"
              ? parseCodexRecord(projected, state)
              : parseClaudeRecord(projected);
          if (record !== null) out.push(record);
        }
      } else if (pendingBytes > 0) {
        const line =
          pendingChunks.length === 1
            ? pendingChunks[0]!
            : Buffer.concat(pendingChunks, pendingBytes);
        parseLine(toLineString(line), state, pi, out);
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
        // Most lines fit in the current chunk. Avoid buffering/streaming
        // machinery on this hot path.
        if (!streaming && pendingBytes === 0) {
          parseLine(
            toLineString(chunk.subarray(lineStart, newlineIndex)),
            codexState,
            piState,
            records,
          );
        } else {
          append(chunk.subarray(lineStart, newlineIndex));
          finish(codexState, piState, records);
        }
        lineStart = newlineIndex + 1;
        resumeOffset = scanOffset + lineStart;
      }
      scanOffset += chunk.length;
    }

    const tailRecords: UsageRecord[] = [];
    const tailPiState = { ...piState };
    finish({ ...codexState }, tailPiState, tailRecords);

    const guardLength = Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      projectPaths: [...new Set([piState.projectPath, tailPiState.projectPath].filter(Boolean))],
      tailRecords,
      position: {
        resumeOffset,
        guardLength,
        guardHash,
        codexState: provider === "codex" ? codexState : null,
        piState: provider === "pi" ? piState : null,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
