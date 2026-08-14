/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  PiSettings,
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
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
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
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

interface TranscriptDir {
  readonly provider: UsageProviderKind;
  readonly dir: string;
}

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodePiSettings = Schema.decodeUnknownEffect(PiSettings);

/**
 * Claude's config dir is the home itself when overridden, but a default
 * install nests transcripts under `~/.claude/projects`. Probe both.
 */
const resolveClaudeTranscriptDir = Effect.fn("UsageService.resolveClaudeTranscriptDir")(function* (
  homePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nested = path.join(homePath, ".claude", "projects");
  const nestedExists = yield* fileSystem
    .exists(nested)
    .pipe(Effect.catchCause(() => Effect.succeed(false)));
  return nestedExists ? nested : path.join(homePath, "projects");
});

function expandPiHomePath(value: string, homePath: string, path: Path.Path): string {
  if (value === "~") return homePath;
  const usesHomePrefix = value.startsWith("~/") || value.startsWith("~\\");
  return usesHomePrefix ? path.join(homePath, value.slice(2)) : value;
}

/** Resolves Pi's session root using the same configuration precedence as its RPC process. */
export function resolvePiTranscriptDir(
  config: PiSettings,
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
): string {
  const homePath = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const sessionOverride = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (sessionOverride) return expandPiHomePath(sessionOverride, homePath, path);

  const configuredAgentDir = config.agentDir.trim();
  const inheritedAgentDir = environment.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir || inheritedAgentDir || path.join(homePath, ".pi", "agent");
  return path.join(expandPiHomePath(agentDir, homePath, path), "sessions");
}

/** Finds pi-subagents child-session roots reachable from Pi session project paths. */
export const resolvePiSubagentTranscriptDirs = Effect.fn(
  "UsageService.resolvePiSubagentTranscriptDirs",
)(function* (projectPaths: Iterable<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = new Set<string>();

  for (const projectPath of projectPaths) {
    let current = path.resolve(projectPath);
    while (true) {
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

/** Resolves and deduplicates transcript directories from every configured instance. */
export const resolveUsageTranscriptDirs = Effect.fn("UsageService.resolveUsageTranscriptDirs")(
  function* (settings: ServerSettingsValue, baseEnvironment: NodeJS.ProcessEnv = process.env) {
    const path = yield* Path.Path;
    const directories = new Map<string, TranscriptDir>();
    const addDirectory = (provider: UsageProviderKind, dir: string) => {
      directories.set(`${provider}\0${dir}`, { provider, dir });
    };

    for (const instance of Object.values(deriveProviderInstanceConfigMap(settings))) {
      if (instance.driver === "claudeAgent") {
        const config = yield* decodeClaudeSettings(instance.config ?? {}).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (config === null) continue;
        const environment = mergeProviderInstanceEnvironment(instance.environment, baseEnvironment);
        const inheritedHome = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
        const effectiveConfig =
          config.homePath.trim().length > 0 || inheritedHome.length === 0
            ? config
            : { ...config, homePath: inheritedHome };
        const home = yield* resolveClaudeHomePath(effectiveConfig);
        addDirectory("claude", yield* resolveClaudeTranscriptDir(home));
        continue;
      }

      if (instance.driver === "codex") {
        const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (config === null) continue;
        const layout = yield* resolveCodexHomeLayout(config);
        addDirectory("codex", path.join(layout.sharedHomePath, "sessions"));
        continue;
      }

      if (instance.driver === "pi") {
        const config = yield* decodePiSettings(instance.config ?? {}).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (config === null) continue;
        const environment = mergeProviderInstanceEnvironment(instance.environment, baseEnvironment);
        addDirectory("pi", resolvePiTranscriptDir(config, environment, path));
      }
    }

    return [...directories.values()];
  },
);

export const resolveUsageSourceReadCoverage = (input: {
  readonly unreadableFiles: number;
  readonly unreadableDirectories: number;
}): Pick<UsageSource, "status" | "message"> => {
  const failures = [
    ...(input.unreadableDirectories > 0
      ? [
          `${input.unreadableDirectories} transcript ${input.unreadableDirectories === 1 ? "directory" : "directories"} could not be read`,
        ]
      : []),
    ...(input.unreadableFiles > 0
      ? [
          `${input.unreadableFiles} transcript ${input.unreadableFiles === 1 ? "file" : "files"} could not be read`,
        ]
      : []),
  ];
  return failures.length > 0
    ? { status: "partial", message: `${failures.join("; ")}.` }
    : { status: "ok", message: null };
};

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
    readonly malformedRecords: number;
    readonly projectPaths: readonly string[];
    readonly readFailed: boolean;
  }> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if multiple providers were ever pointed
      // at one directory, a hit parsed by another parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return {
          records: cached.records,
          malformedRecords: cached.malformedRecords,
          projectPaths: cached.projectPaths,
          readFailed: false,
        };
      }

      const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, provider));
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) {
        return { records: [], malformedRecords: 0, projectPaths: [], readFailed: true };
      }
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile(parsed.records);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        malformedRecords: parsed.malformedRecords,
        projectPaths: parsed.projectPaths,
      });
      cacheDirty = true;
      return {
        records,
        malformedRecords: parsed.malformedRecords,
        projectPaths: parsed.projectPaths,
        readFailed: false,
      };
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
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );
    // The home resolvers ask for filesystem services themselves; satisfy them
    // from the instances already held by this service so readSummary stays context-free.
    const initialDirs = yield* resolveUsageTranscriptDirs(settings).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const dirs = [...initialDirs];
    const knownDirs = new Set(dirs.map(({ provider, dir }) => `${provider}\0${dir}`));
    const enqueueDir = (provider: UsageProviderKind, dir: string) => {
      const key = `${provider}\0${dir}`;
      if (knownDirs.has(key)) return;
      knownDirs.add(key);
      dirs.push({ provider, dir });
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

    for (let dirIndex = 0; dirIndex < dirs.length; dirIndex += 1) {
      const transcriptDir = dirs[dirIndex];
      if (transcriptDir === undefined) continue;
      const { provider, dir } = transcriptDir;
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

      const listing = yield* Effect.promise(() => listTranscriptFiles(dir, windowStartMs));
      // Only a complete walk proves an absent cached file was deleted.
      if (listing.unreadableDirectories === 0) walkedRoots.push(dir);
      let scannedFiles = 0;
      let skippedFiles = 0;
      let unreadableFiles = 0;
      let malformedRecords = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      const projectPaths = new Set<string>();

      for (const file of listing.files) {
        livePaths.add(file.path);
        const read = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        for (const projectPath of read.projectPaths) projectPaths.add(projectPath);
        if (read.readFailed) unreadableFiles += 1;
        malformedRecords += read.malformedRecords;
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
        ...resolveUsageSourceReadCoverage({
          unreadableFiles,
          unreadableDirectories: listing.unreadableDirectories,
        }),
        scannedFiles,
        skippedFiles,
        malformedRecords,
        distinctSessions: sessionIds.size,
      });

      if (provider === "pi" && projectPaths.size > 0) {
        const subagentDirs = yield* resolvePiSubagentTranscriptDirs(projectPaths).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        for (const subagentDir of subagentDirs) enqueueDir("pi", subagentDir);
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
