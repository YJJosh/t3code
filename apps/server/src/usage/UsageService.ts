/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files (Claude Code, Codex,
 * Grok Build, and Pi) rather than T3 Code's orchestration projections, so usage covers
 * turns driven outside T3 Code too. This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
  type TranscriptFileOptions,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

/** Pi's predecessor Tau derives the same overrides from its application name. */
const PI_AGENT_DIR_ENV_NAMES = ["PI_CODING_AGENT_DIR", "TAU_CODING_AGENT_DIR"] as const;
const PI_SESSION_DIR_ENV_NAMES = [
  "PI_CODING_AGENT_SESSION_DIR",
  "TAU_CODING_AGENT_SESSION_DIR",
] as const;

/** Pi's standard sessions layout is `<sessions>/<project>/<transcript>`. */
const PI_SESSION_SCAN_OPTIONS: TranscriptFileOptions = { maxDepth: 1 };
/** Pi v0.30 mistakenly wrote sessions directly under the agent directory. */
const PI_LEGACY_SESSION_SCAN_OPTIONS: TranscriptFileOptions = { maxDepth: 0 };
/** The subagent extension keeps sessions beside non-transcript event journals. */
const PI_SUBAGENT_SESSION_SCAN_OPTIONS: TranscriptFileOptions = {
  maxDepth: 2,
  piSubagentSessionsOnly: true,
};
const MAX_PI_PROJECT_ANCESTOR_DEPTH = 32;

/** Expands a leading `~` and resolves relative paths as Pi's `normalizePath` does. */
function resolvePiPath(value: string, homePath: string, path: Path.Path): string {
  const expanded =
    value === "~"
      ? homePath
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(homePath, value.slice(2))
        : value;
  return path.resolve(expanded);
}

function firstDefinedEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** Resolves Pi's agent directory, including the predecessor's dynamic env name. */
export function resolvePiAgentDir(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  const homePath = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const agentOverride = firstDefinedEnvironmentPath(environment, PI_AGENT_DIR_ENV_NAMES);
  return resolvePiPath(agentOverride ?? path.join(homePath, ".pi", "agent"), homePath, path);
}

/**
 * Resolves Pi's session root using the same precedence Pi's own process uses:
 * an explicit session-dir override, then `<agentDir>/sessions`. Pi derives its
 * env names from its app name, so accept Tau's legacy names after Pi's.
 */
export function resolvePiTranscriptDir(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  const homePath = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const sessionOverride = firstDefinedEnvironmentPath(environment, PI_SESSION_DIR_ENV_NAMES);
  if (sessionOverride !== undefined) return resolvePiPath(sessionOverride, homePath, path);
  return path.join(resolvePiAgentDir(environment, path), "sessions");
}

/** Finds bounded, de-duplicated Pi subagent roots reachable from project paths. */
export const resolvePiSubagentTranscriptDirs = Effect.fn(
  "UsageService.resolvePiSubagentTranscriptDirs",
)(function* (projectPaths: Iterable<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = new Set<string>();
  const checkedDirectories = new Set<string>();

  for (const projectPath of projectPaths) {
    let current = path.resolve(projectPath);
    for (let depth = 0; depth < MAX_PI_PROJECT_ANCESTOR_DEPTH; depth += 1) {
      // A previously traversed ancestor already implies every parent was
      // checked too, which bounds repeated filesystem work across sessions.
      if (checkedDirectories.has(current)) break;
      checkedDirectories.add(current);

      const runs = path.join(current, ".pi-subagents", "runs");
      const exists = yield* fileSystem
        .exists(runs)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (exists) roots.add(runs);

      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return [...roots];
});

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: LITELLM_RATES_URL,
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: 0,
      }),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
  });

  /**
   * Claude's config dir is the home itself when overridden, but a default
   * install nests transcripts under `~/.claude/projects`. Probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  interface TranscriptDirectory {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly scanOptions?: TranscriptFileOptions;
    /** False when the scan only covers direct files and cannot prove descendant deletion. */
    readonly completeForCachePruning?: boolean;
  }

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* () {
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            // Bounded description; the squashed failure travels as the cause.
            // Squashed, not the Cause tree: a full tree in a Defect field is
            // the unbounded wire payload the bounded detail exists to avoid.
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );

    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    const claudeDir = yield* resolveClaudeTranscriptDir(claudeHome);
    const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);
    // Grok Settings only expose the binary path; home is `$GROK_HOME` or `~/.grok`.
    // Empty/whitespace GROK_HOME must fall back: coalescing alone would scan cwd.
    const grokHomeEnv = hostEnvironment["GROK_HOME"]?.trim() ?? "";
    const grokHome =
      grokHomeEnv.length > 0
        ? path.resolve(expandHomePath(grokHomeEnv))
        : path.join(NodeOS.homedir(), ".grok");

    // Pi resolves purely from environment and default, mirroring Grok: the Pi
    // provider core is not part of this slice, so there is no configured home
    // to consult yet. Scan its normal layout, the v0.30 direct-file layout,
    // and any subagent runs rooted in the agent directory.
    const piAgentDir = resolvePiAgentDir(hostEnvironment, path);
    const piDir = resolvePiTranscriptDir(hostEnvironment, path);

    return [
      { provider: "claude" as const, dir: claudeDir },
      { provider: "codex" as const, dir: path.join(codexLayout.sharedHomePath, "sessions") },
      {
        provider: "grok" as const,
        dir: path.join(grokHome, "sessions"),
        scanOptions: { fileName: "updates.jsonl" },
      },
      { provider: "pi" as const, dir: piDir, scanOptions: PI_SESSION_SCAN_OPTIONS },
      {
        provider: "pi" as const,
        dir: piAgentDir,
        scanOptions: PI_LEGACY_SESSION_SCAN_OPTIONS,
        // This root only lists direct files, so it cannot establish that
        // cached descendants such as `<agent>/sessions/**` disappeared.
        completeForCachePruning: false,
      },
      {
        provider: "pi" as const,
        dir: path.join(piAgentDir, ".pi-subagents", "runs"),
        scanOptions: PI_SUBAGENT_SESSION_SCAN_OPTIONS,
      },
    ] satisfies readonly TranscriptDirectory[];
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile(encodeScanCache(fileCache)).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<{
    readonly records: readonly UsageRecord[];
    readonly projectPaths: readonly string[];
  }> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if multiple providers were ever
      // pointed at one directory, a hit parsed by another parser must not be
      // reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return { records: cached.records, projectPaths: cached.projectPaths };
      }

      const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, provider));
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return { records: [], projectPaths: [] };
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile(parsed.records);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        projectPaths: parsed.projectPaths,
      });
      cacheDirty = true;
      return { records, projectPaths: parsed.projectPaths };
    });

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureRates();
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    const initialDirs = yield* resolveTranscriptDirs().pipe(Effect.provideService(Path.Path, path));
    // Pi subagent roots are discovered mid-scan from the project paths the Pi
    // sessions declare, so the work list grows as those directories are found.
    const dirs: TranscriptDirectory[] = [...initialDirs];
    const knownDirs = new Set(dirs.map(({ provider, dir }) => `${provider}\0${dir}`));
    const enqueuePiSubagentDir = (dir: string) => {
      const key = `pi\0${dir}`;
      if (knownDirs.has(key)) return;
      knownDirs.add(key);
      dirs.push({ provider: "pi", dir, scanOptions: PI_SUBAGENT_SESSION_SCAN_OPTIONS });
    };
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    // Index-based: discovered Pi subagent roots can extend the work list while we iterate.
    for (let dirIndex = 0; dirIndex < dirs.length; dirIndex += 1) {
      const transcriptDir = dirs[dirIndex];
      if (transcriptDir === undefined) continue;
      const { provider, dir, scanOptions } = transcriptDir;
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));

      if (!exists) {
        sources.push({
          fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No transcript directory on this environment.",
        });
        continue;
      }

      const listing = yield* Effect.promise(() =>
        listTranscriptFiles(dir, windowStartMs, scanOptions),
      );
      // The v0.30 compatibility root intentionally lists direct files only,
      // so it cannot establish that cached descendants disappeared.
      if (transcriptDir.completeForCachePruning !== false) walkedRoots.push(dir);
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      const projectPaths = new Set<string>();

      for (const file of listing.files) {
        livePaths.add(file.path);
        const read = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        for (const projectPath of read.projectPaths) projectPaths.add(projectPath);
        if (read.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of read.records) {
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        status: "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message: null,
      });

      if (provider === "pi" && projectPaths.size > 0) {
        const subagentDirs = yield* resolvePiSubagentTranscriptDirs(projectPaths).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        for (const subagentDir of subagentDirs) enqueuePiSubagentDir(subagentDir);
      }
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  return { readSummary } as const;
});

export const layer = Layer.effect(UsageService, make);
