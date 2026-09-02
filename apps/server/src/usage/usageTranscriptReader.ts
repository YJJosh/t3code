// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  initialPiScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parsePiLine,
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

export interface TranscriptReadResult {
  readonly records: readonly UsageRecord[];
  /** Project roots declared by Pi session headers, used to discover subagent sessions. */
  readonly projectPaths: readonly string[];
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

/**
 * Streams one transcript and returns its usage records plus any Pi project
 * roots, or `null` when the file could not be read. The read-failure distinction
 * matters to the caller's cache: a genuinely empty transcript is a stable fact
 * worth memoising, while a transient read failure memoised under the same
 * `(size, mtime)` key would silently drop that file's usage until it next changes.
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
): Promise<TranscriptReadResult | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const piState = initialPiScanState();

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (provider === "grok") {
        if (!mightCarryUsage(line, provider)) continue;
        for (const grokRecord of parseGrokLine(line)) records.push(grokRecord);
        continue;
      }

      if (provider === "pi") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"type":"session"') &&
          !line.includes('"type": "session"') &&
          !line.includes('"model_change"')
        ) {
          continue;
        }
        const record = parsePiLine(line, piState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return {
    records,
    projectPaths: piState.projectPath.length > 0 ? [piState.projectPath] : [],
  };
}
