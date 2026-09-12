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

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  initialPiScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parsePiLine,
  type PiScanState,
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
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

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
): Promise<TranscriptParseResult | null> {
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
    // Buffer-level line splitting rather than `readline`, because resuming
    // needs byte-exact offsets and decoded strings cannot provide them.
    // Newline-free chunks are collected rather than concatenated as they
    // arrive, so a single huge line costs one copy instead of one per chunk.
    let resumeOffset = start;
    let pendingChunks: Buffer[] = [];
    const stream = handle.createReadStream({
      start,
      autoClose: false,
    }) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      if (!chunk.includes(NEWLINE)) {
        pendingChunks.push(chunk);
        continue;
      }
      const buffer: Buffer =
        pendingChunks.length === 0 ? chunk : Buffer.concat([...pendingChunks, chunk]);
      pendingChunks = [];
      let lineStart = 0;
      for (;;) {
        const newlineIndex = buffer.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) break;
        parseLine(
          toLineString(buffer.subarray(lineStart, newlineIndex)),
          codexState,
          piState,
          records,
        );
        lineStart = newlineIndex + 1;
      }
      resumeOffset += lineStart;
      if (lineStart < buffer.length) pendingChunks.push(buffer.subarray(lineStart));
    }

    // A trailing segment without its newline is parsed for this result but not
    // consumed: a writer may still be appending to it, and counting a half
    // record now and its full form later would double count.
    const tailRecords: UsageRecord[] = [];
    const tailPiState = { ...piState };
    if (pendingChunks.length > 0) {
      const pending = pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks);
      if (pending.length > 0)
        parseLine(toLineString(pending), { ...codexState }, tailPiState, tailRecords);
    }

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
