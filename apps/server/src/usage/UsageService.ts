/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files (Claude Code, Codex,
 * Grok Build, and Pi) rather than T3 Code's orchestration projections, so usage covers
 * turns driven outside T3 Code too. This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed, and a file that merely grew resumes
 * from its cached parse position so only the appended bytes are read.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  GrokSettings,
  PiSettings,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerSettings as ServerSettingsContract,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolvePiAgentDir as resolveConfiguredPiAgentDir } from "../provider/pi/piPaths.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
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

/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

/** Pi's predecessor Tau derives the same overrides from its application name. */
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
const MAX_USAGE_SOURCE_ANCESTORS = 8;
const decodeClaudeSettingsOption = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettingsOption = Schema.decodeUnknownOption(CodexSettings);
const decodeGrokSettingsOption = Schema.decodeUnknownOption(GrokSettings);
const decodePiSettingsOption = Schema.decodeUnknownOption(PiSettings);

interface TranscriptDirectory {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly scanOptions?: TranscriptFileOptions;
  /** False when the scan only covers direct files and cannot prove descendant deletion. */
  readonly completeForCachePruning?: boolean;
}

interface PiTranscriptSettings {
  readonly providers: Pick<ServerSettingsContract["providers"], "pi">;
  readonly providerInstances: ServerSettingsContract["providerInstances"];
}

function piSourceScan(scanOptions: TranscriptFileOptions | undefined) {
  if (scanOptions?.maxDepth === undefined) return undefined;
  return {
    maxDepth: scanOptions.maxDepth,
    filePattern: scanOptions.piSubagentSessionsOnly
      ? ("pi-subagent-session" as const)
      : ("jsonl" as const),
  };
}

async function readAncestorVolumeIds(dir: string, path: Path.Path): Promise<readonly string[]> {
  const ancestors: string[] = [];
  let current = dir;
  for (let depth = 0; depth < MAX_USAGE_SOURCE_ANCESTORS; depth += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    ancestors.push(parent);
    current = parent;
  }
  return Promise.all(ancestors.map(readDirectoryVolumeId));
}

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

/** Resolves Pi's configured agent directory, including Pi/Tau environment overrides. */
export function resolvePiAgentDir(
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  configuredAgentDir?: string,
): string {
  return path.resolve(
    resolveConfiguredPiAgentDir(path, { agentDir: configuredAgentDir, environment }),
  );
}

/**
 * Resolves Pi's session root using the same precedence Pi's own process uses:
 * an explicit session-dir override, then `<agentDir>/sessions`. Pi derives its
 * env names from its app name, so accept Tau's legacy names after Pi's.
 */
export function resolvePiTranscriptDir(
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  configuredAgentDir?: string,
): string {
  const homePath = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const sessionOverride = firstDefinedEnvironmentPath(environment, PI_SESSION_DIR_ENV_NAMES);
  if (sessionOverride !== undefined) return resolvePiPath(sessionOverride, homePath, path);
  return path.join(resolvePiAgentDir(environment, path, configuredAgentDir), "sessions");
}

/** Resolves and de-duplicates the transcript roots used by every configured Pi instance. */
export function resolveConfiguredPiTranscriptDirs(
  settings: PiTranscriptSettings,
  hostEnvironment: NodeJS.ProcessEnv,
  path: Path.Path,
): readonly TranscriptDirectory[] {
  const configuredInstances: ProviderInstanceConfig[] = Object.values(settings.providerInstances);
  // The runtime synthesizes the default instance from the legacy settings only
  // when an explicit entry has not claimed the canonical `pi` slot.
  if (!("pi" in settings.providerInstances)) {
    configuredInstances.push({
      driver: ProviderDriverKind.make("pi"),
      config: settings.providers.pi,
    });
  }

  const directories = new Map<string, TranscriptDirectory>();
  const append = (directory: TranscriptDirectory, kind: "sessions" | "legacy" | "subagents") => {
    // Session and legacy scans both accept ordinary Pi transcripts. When they
    // resolve to the same root, one max-depth scan covers both layouts. Keep
    // subagent scans separate because their filename filter excludes journals.
    const key = `${kind === "subagents" ? kind : "transcripts"}\0${directory.dir}`;
    const existing = directories.get(key);
    if (existing === undefined) {
      directories.set(key, directory);
      return;
    }
    if (kind === "subagents") return;
    directories.set(key, {
      ...existing,
      scanOptions: {
        maxDepth: Math.max(
          existing.scanOptions?.maxDepth ?? 0,
          directory.scanOptions?.maxDepth ?? 0,
        ),
      },
      ...(existing.completeForCachePruning === false || directory.completeForCachePruning === false
        ? { completeForCachePruning: false }
        : {}),
    });
  };

  for (const instance of configuredInstances) {
    if (instance.driver !== "pi") continue;
    const decoded = decodePiSettingsOption(instance.config ?? {});
    if (Option.isNone(decoded)) continue;

    const environment = mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
    const configuredAgentDir = decoded.value.agentDir || undefined;
    const agentDir = resolvePiAgentDir(environment, path, configuredAgentDir);
    const sessionDir = resolvePiTranscriptDir(environment, path, configuredAgentDir);

    append({ provider: "pi", dir: sessionDir, scanOptions: PI_SESSION_SCAN_OPTIONS }, "sessions");
    append(
      {
        provider: "pi",
        dir: agentDir,
        scanOptions: PI_LEGACY_SESSION_SCAN_OPTIONS,
        // This root only lists direct files, so it cannot establish that
        // cached descendants such as `<agent>/sessions/**` disappeared.
        completeForCachePruning: false,
      },
      "legacy",
    );
    append(
      {
        provider: "pi",
        dir: path.join(agentDir, ".pi-subagents", "runs"),
        scanOptions: PI_SUBAGENT_SESSION_SCAN_OPTIONS,
      },
      "subagents",
    );
  }

  return [...directories.values()];
}

/**
 * Claude's config dir is the home itself when overridden, but a default
 * install nests transcripts under `~/.claude/projects`. Probe both.
 */
const resolveClaudeTranscriptDirectory = Effect.fn("UsageService.resolveClaudeTranscriptDirectory")(
  function* (homePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nested = path.join(homePath, ".claude", "projects");
    const nestedExists = yield* fileSystem
      .exists(nested)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    return nestedExists ? nested : path.join(homePath, "projects");
  },
);

/** Resolves and de-duplicates transcript roots from every configured instance. */
export const resolveUsageTranscriptDirs = Effect.fn("UsageService.resolveUsageTranscriptDirs")(
  function* (settings: ServerSettingsContract, hostEnvironment: NodeJS.ProcessEnv = process.env) {
    const path = yield* Path.Path;
    const directories = new Map<string, TranscriptDirectory>();
    const append = (directory: TranscriptDirectory) => {
      const options = directory.scanOptions;
      const key = [
        directory.provider,
        directory.dir,
        options?.fileName ?? "",
        options?.maxDepth ?? "",
        options?.piSubagentSessionsOnly === true ? "subagents" : "",
      ].join("\0");
      if (!directories.has(key)) directories.set(key, directory);
    };

    for (const instance of Object.values(deriveProviderInstanceConfigMap(settings))) {
      const environment = mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
      const homePath =
        environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();

      if (instance.driver === "claudeAgent") {
        const decoded = decodeClaudeSettingsOption(instance.config ?? {});
        if (Option.isNone(decoded)) continue;
        const configuredHome = decoded.value.homePath.trim();
        const inheritedHome = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
        const claudeHome =
          configuredHome.length > 0
            ? yield* resolveClaudeHomePath(decoded.value)
            : inheritedHome.length > 0
              ? resolvePiPath(inheritedHome, homePath, path)
              : path.resolve(homePath);
        append({ provider: "claude", dir: yield* resolveClaudeTranscriptDirectory(claudeHome) });
        continue;
      }

      if (instance.driver === "codex") {
        const decoded = decodeCodexSettingsOption(instance.config ?? {});
        if (Option.isNone(decoded)) continue;
        const configuredHome = decoded.value.homePath.trim();
        const inheritedHome = environment.CODEX_HOME?.trim() ?? "";
        const codexHome =
          configuredHome.length > 0
            ? decoded.value.homePath
            : inheritedHome.length > 0
              ? resolvePiPath(inheritedHome, homePath, path)
              : path.join(homePath, ".codex");
        const layout = yield* resolveCodexHomeLayout({ ...decoded.value, homePath: codexHome });
        append({ provider: "codex", dir: path.join(layout.sharedHomePath, "sessions") });
        continue;
      }

      if (instance.driver === "grok") {
        const decoded = decodeGrokSettingsOption(instance.config ?? {});
        if (Option.isNone(decoded)) continue;
        const inheritedHome = environment.GROK_HOME?.trim() ?? "";
        const grokHome =
          inheritedHome.length > 0
            ? resolvePiPath(inheritedHome, homePath, path)
            : path.join(homePath, ".grok");
        append({
          provider: "grok",
          dir: path.join(grokHome, "sessions"),
          scanOptions: { fileName: "updates.jsonl" },
        });
      }
    }

    for (const directory of resolveConfiguredPiTranscriptDirs(settings, hostEnvironment, path)) {
      append(directory);
    }

    return [...directories.values()];
  },
);

export function resolveUsageSourceReadCoverage(input: {
  readonly unreadableFiles: number;
  readonly unreadableDirectories: number;
}): Pick<UsageSource, "status" | "message"> {
  const failures = [
    ...(input.unreadableDirectories > 0
      ? [
          `${String(input.unreadableDirectories)} transcript ${input.unreadableDirectories === 1 ? "directory" : "directories"} could not be read`,
        ]
      : []),
    ...(input.unreadableFiles > 0
      ? [
          `${String(input.unreadableFiles)} transcript ${input.unreadableFiles === 1 ? "file" : "files"} could not be read`,
        ]
      : []),
  ];
  return failures.length > 0
    ? { status: "partial", message: `${failures.join("; ")}.` }
    : { status: "ok", message: null };
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
    /** Refetches the rate table ahead of its TTL. See `ensureRates`. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
};

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
        pricing: EMPTY_PRICING,
        scanDurationMs: 0,
      }),
    refreshRates: Effect.succeed(EMPTY_PRICING),
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
  let ratesStatus: UsagePricing["status"] = "unavailable";
  // One fetch at a time. A burst of refreshes from several clients waits on
  // the first fetch and then sees a table young enough to skip its own.
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing. `force` refetches inside the TTL so a model that
   * LiteLLM added since the last fetch gets priced now.
   */
  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

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
          if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
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

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  // A settings failure must not silently discard custom rates or transcript homes.
  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

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

  /**
   * Parses one transcript, reusing the cached result when it is unchanged.
   *
   * A file that only grew re-parses from the cached position, so an actively
   * written multi-hundred-megabyte rollout costs its appended bytes per scan
   * rather than a full re-read. The reader verifies the position's guard bytes
   * and silently restarts from byte 0 when they no longer match.
   */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<{
    readonly records: readonly UsageRecord[];
    readonly projectPaths: readonly string[];
    readonly readFailed: boolean;
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
        return {
          records:
            cached.tailRecords.length === 0
              ? cached.records
              : [...cached.records, ...cached.tailRecords],
          projectPaths: cached.projectPaths,
          readFailed: false,
        };
      }

      // Only a strictly grown file may resume. Same size with a new mtime, or
      // a shrunken file, means rewritten content; re-parse it whole.
      const resumeFrom =
        cached !== undefined && cached.provider === provider && size > cached.size
          ? cached.position
          : undefined;

      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, resumeFrom),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return { records: [], projectPaths: [], readFailed: true };
      // One seen set spans the cached base, appended lines and tail so resumed
      // parsing deduplicates exactly like a full parse, including Pi fork copies.
      const base = parsed.resumed && cached !== undefined ? cached.records : [];
      const seen = new Set<string>();
      const records = dedupeWithinFile([...base, ...parsed.records], seen);
      const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        tailRecords,
        position: parsed.position,
        projectPaths: parsed.projectPaths,
      });
      cacheDirty = true;
      return {
        records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
        projectPaths: parsed.projectPaths,
        readFailed: false,
      };
    });

  /** One provider directory's walk and parse, before rates are involved. */
  interface ScannedDir extends TranscriptDirectory {
    readonly volumeId: string;
    readonly ancestorVolumeIds?: readonly string[];
    readonly unreadableDirectories: number;
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files:
      | readonly {
          readonly path: string;
          readonly records: readonly UsageRecord[];
          readonly readFailed: boolean;
        }[]
      | null;
  }

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsContract,
  ) {
    const initialDirs = yield* resolveUsageTranscriptDirs(settings, hostEnvironment).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    // Pi project paths can discover additional child-session roots mid-scan.
    const dirs: TranscriptDirectory[] = [...initialDirs];
    const knownDirs = new Set(dirs.map(({ provider, dir }) => `${provider}\0${dir}`));
    const scanned: ScannedDir[] = [];
    for (let dirIndex = 0; dirIndex < dirs.length; dirIndex += 1) {
      const transcriptDir = dirs[dirIndex];
      if (transcriptDir === undefined) continue;
      const { provider, dir, scanOptions } = transcriptDir;
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        scanned.push({ ...transcriptDir, volumeId, files: null, unreadableDirectories: 0 });
        continue;
      }
      const ancestorVolumeIds =
        provider === "pi"
          ? yield* Effect.promise(() => readAncestorVolumeIds(dir, path))
          : undefined;
      const listing = yield* Effect.promise(() =>
        listTranscriptFiles(dir, windowStartMs, scanOptions),
      );
      const parsedFiles: { path: string; records: readonly UsageRecord[]; readFailed: boolean }[] =
        [];
      const projectPaths = new Set<string>();
      for (const file of listing.files) {
        const read = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        for (const projectPath of read.projectPaths) projectPaths.add(projectPath);
        parsedFiles.push({ path: file.path, records: read.records, readFailed: read.readFailed });
      }
      scanned.push({
        ...transcriptDir,
        volumeId,
        ...(ancestorVolumeIds === undefined ? {} : { ancestorVolumeIds }),
        files: parsedFiles,
        unreadableDirectories: listing.unreadableDirectories,
      });
      if (provider === "pi" && projectPaths.size > 0) {
        const subagentDirs = yield* resolvePiSubagentTranscriptDirs(projectPaths).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        for (const subagentDir of subagentDirs) {
          const key = `pi\0${subagentDir}`;
          if (knownDirs.has(key)) continue;
          knownDirs.add(key);
          dirs.push({
            provider: "pi",
            dir: subagentDir,
            scanOptions: PI_SUBAGENT_SESSION_SCAN_OPTIONS,
          });
        }
      }
    }
    return scanned;
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsContract,
  ) {
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
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    // Pricing only matters once records are aggregated, so the rate table
    // loads while transcripts stream instead of gating them: a cold rates
    // fetch on a slow network no longer delays the scan by its own timeout.
    const [, scannedDirs] = yield* Effect.all(
      [ensureRates(false), collectDirs(windowStartMs, settings)],
      { concurrency: 2 },
    );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const processedFiles = new Set<string>();
    const walkedRoots: string[] = [];

    for (const transcriptDir of scannedDirs) {
      const { provider, dir, files, volumeId, ancestorVolumeIds, scanOptions } = transcriptDir;
      const sourceIndex = sources.length;
      const scan = provider === "pi" ? piSourceScan(scanOptions) : undefined;
      const fingerprint = {
        hostId,
        provider,
        resolvedHomePath: dir,
        volumeId,
        ...(ancestorVolumeIds === undefined ? {} : { ancestorVolumeIds }),
      };
      if (files === null) {
        sources.push({
          fingerprint,
          ...(scan === undefined ? {} : { scan }),
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No transcript directory on this environment.",
        });
        continue;
      }

      // Only a complete recursive walk proves absent cached descendants were
      // deleted. The direct-only Pi legacy root cannot prove that either.
      if (
        transcriptDir.unreadableDirectories === 0 &&
        transcriptDir.completeForCachePruning !== false
      ) {
        walkedRoots.push(dir);
      }
      let scannedFiles = 0;
      let skippedFiles = 0;
      let unreadableFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of files) {
        livePaths.add(file.path);
        const processedFileKey = `${provider}\0${file.path}`;
        if (processedFiles.has(processedFileKey)) continue;
        processedFiles.add(processedFileKey);
        if (file.readFailed) unreadableFiles += 1;
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of file.records) {
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record, sourceIndex) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint,
        ...(scan === undefined ? {} : { scan }),
        ...resolveUsageSourceReadCoverage({
          unreadableFiles,
          unreadableDirectories: transcriptDir.unreadableDirectories,
        }),
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
      });
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
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  /**
   * In-flight scans by window, custom prices and provider configuration, so
   * concurrent identical requests share one scan without reusing a scan of
   * outdated transcript roots after an instance's settings change.
   */
  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (input: UsageSummaryInput, settings: ServerSettingsContract): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings.usagePriceOverrides,
      settings.providers,
      settings.providerInstances,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const settings = yield* readSettings;
    const key = scanKey(input, settings);
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Enrollment and detached-fiber creation must be atomic. Otherwise a
        // canceled first caller can leave a Deferred with no scan to finish it.
        const created = Deferred.makeUnsafe<UsageSummary, UsageReadError>();
        inflightScans.set(key, created);
        // Detached so one departing client cannot tear the scan out from under
        // the fibers awaiting it; a finished scan warms the cache either way.
        yield* scanSummary(input, settings).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightScans.delete(key)).pipe(
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    // Waiting stays interruptible. The detached scan continues for other
    // callers and still warms the cache if this caller leaves.
    return yield* Deferred.await(deferred);
  });

  return { readSummary, refreshRates } as const;
});

export const layer = Layer.effect(UsageService, make);
