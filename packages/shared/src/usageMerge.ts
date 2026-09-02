/**
 * Merges per-environment usage summaries into the single view the page renders.
 *
 * Pure, so the de-duplication and derivation rules can be tested without a
 * connected environment.
 *
 * @module usageMerge
 */
import {
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
} from "@t3tools/contracts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

export interface ProviderTotals {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals {
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly costShare: number;
}

export interface DailyTotals {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface HourlyTotals {
  readonly day: string;
  readonly hourStart: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
}

export interface MergedUsage {
  readonly costUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly staleEnvironments: readonly EnvironmentId[];
}

/**
 * Two sources are the same physical transcript directory only when host,
 * provider, path and filesystem identity all agree.
 *
 * `volumeId` is what stops two machines that happen to share a hostname and a
 * home path, which is every Mac in a fleet, from collapsing into one source and
 * having one of them silently dropped.
 */
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

function normalizePortablePath(value: string): string {
  let normalized = value.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  if (/^[a-z]:\//i.test(normalized)) normalized = normalized.toLowerCase();
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

/** Returns how many directories `descendant` is below `ancestor`. */
function descendantDepth(ancestor: string, descendant: string): number | undefined {
  const normalizedAncestor = normalizePortablePath(ancestor);
  const normalizedDescendant = normalizePortablePath(descendant);
  if (normalizedAncestor === normalizedDescendant) return 0;
  const prefix = normalizedAncestor === "/" ? "/" : `${normalizedAncestor}/`;
  if (!normalizedDescendant.startsWith(prefix)) return undefined;
  return normalizedDescendant.slice(prefix.length).split("/").filter(Boolean).length;
}

function pathDepth(value: string): number {
  return normalizePortablePath(value).split("/").filter(Boolean).length;
}

/** True when the first source's bounded scan includes every file in the second. */
function sourceCovers(covering: UsageSource, covered: UsageSource): boolean {
  if (covering.status !== "ok") return false;
  const coveringFingerprint = covering.fingerprint;
  const coveredFingerprint = covered.fingerprint;
  if (
    coveringFingerprint.hostId !== coveredFingerprint.hostId ||
    coveringFingerprint.provider !== coveredFingerprint.provider
  ) {
    return false;
  }

  const depth = descendantDepth(
    coveringFingerprint.resolvedHomePath,
    coveredFingerprint.resolvedHomePath,
  );
  if (depth === undefined) return false;

  const samePhysicalDirectory =
    depth === 0 &&
    coveringFingerprint.volumeId.length > 0 &&
    coveringFingerprint.volumeId === coveredFingerprint.volumeId;
  const provenPhysicalAncestor =
    depth > 0 &&
    coveringFingerprint.volumeId.length > 0 &&
    coveredFingerprint.ancestorVolumeIds?.[depth - 1] === coveringFingerprint.volumeId;
  if (!samePhysicalDirectory && !provenPhysicalAncestor) return false;

  if (covering.scan === undefined || covered.scan === undefined) {
    return (
      depth === 0 && fingerprintKey(coveringFingerprint) === fingerprintKey(coveredFingerprint)
    );
  }
  if (covering.scan.filePattern === "pi-subagent-session") {
    return (
      depth === 0 &&
      covered.scan.filePattern === "pi-subagent-session" &&
      covering.scan.maxDepth >= covered.scan.maxDepth
    );
  }
  return covering.scan.maxDepth >= depth + covered.scan.maxDepth;
}

interface SourceClaim {
  readonly environment: EnvironmentUsage;
  readonly source: UsageSource;
  readonly sourceIndex: number;
}

function sourceClaimKey(environmentId: EnvironmentId, sourceIndex: number): string {
  return `${environmentId}\0${String(sourceIndex)}`;
}

/**
 * Decides which environment owns each physical transcript scan.
 *
 * Broader proven scans claim contained roots first, so environments that choose
 * differently nested Pi roots cannot count the contained files twice. Parent
 * inode chains prove containment across environment boundaries; path strings
 * and hostnames alone are intentionally insufficient. Legacy summaries without
 * source attribution retain the provider-level fallback.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownedSourceKeys: ReadonlySet<string>;
  readonly duplicates: readonly string[];
} {
  const candidates: SourceClaim[] = [];
  for (const environment of environments) {
    for (const [sourceIndex, source] of environment.summary.sources.entries()) {
      if (source.status !== "missing") candidates.push({ environment, source, sourceIndex });
    }
  }
  candidates.sort((a, b) => {
    const pathOrder =
      pathDepth(a.source.fingerprint.resolvedHomePath) -
      pathDepth(b.source.fingerprint.resolvedHomePath);
    if (pathOrder !== 0) return pathOrder;
    const patternOrder =
      Number(a.source.scan?.filePattern === "pi-subagent-session") -
      Number(b.source.scan?.filePattern === "pi-subagent-session");
    if (patternOrder !== 0) return patternOrder;
    const depthOrder = (b.source.scan?.maxDepth ?? -1) - (a.source.scan?.maxDepth ?? -1);
    if (depthOrder !== 0) return depthOrder;
    return (
      a.environment.environmentId.localeCompare(b.environment.environmentId) ||
      a.sourceIndex - b.sourceIndex
    );
  });

  const claimed: SourceClaim[] = [];
  const ownedSourceKeys = new Set<string>();
  const duplicates: string[] = [];
  for (const candidate of candidates) {
    const duplicate = claimed.some(
      (existing) =>
        existing.environment.environmentId !== candidate.environment.environmentId &&
        sourceCovers(existing.source, candidate.source),
    );
    if (duplicate) {
      duplicates.push(
        `${candidate.environment.label}: ${candidate.source.fingerprint.resolvedHomePath}`,
      );
      continue;
    }
    claimed.push(candidate);
    ownedSourceKeys.add(sourceClaimKey(candidate.environment.environmentId, candidate.sourceIndex));
  }

  return { ownedSourceKeys, duplicates };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownedSourceKeys: ReadonlySet<string>,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSourceIndexes = new Set<number>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const [sourceIndex, source] of environment.summary.sources.entries()) {
    if (
      source.status !== "missing" &&
      ownedSourceKeys.has(sourceClaimKey(environment.environmentId, sourceIndex))
    ) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      ownedSourceIndexes.add(sourceIndex);
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) + source.distinctSessions,
      );
    }
  }
  return {
    buckets: environment.summary.buckets.filter((bucket) => {
      if (bucket.sourceIndex === undefined) return ownedProviders.has(bucket.provider);
      const source = environment.summary.sources[bucket.sourceIndex];
      return (
        ownedSourceIndexes.has(bucket.sourceIndex) &&
        source?.fingerprint.provider === bucket.provider
      );
    }),
    sessionsByProvider,
  };
}

function bucketTokens(bucket: UsageBucket): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens
  );
}

function isCompatibleContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= expected;
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  sessions: 0,
  providers: [],
  models: [],
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  duplicateSources: [],
  contributingEnvironments: [],
  staleEnvironments: [],
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against an environment running older server
 * code: rather than blocking the page, incompatible data is excluded and its
 * id is reported so the UI can say coverage is partial. Versions in
 * [{@link USAGE_MERGE_COMPATIBLE_SINCE}, expected] still merge, so an additive
 * provider expansion does not drop Claude/Codex totals from older servers.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const staleEnvironments: EnvironmentId[] = [];
  for (const environment of environments) {
    if (isCompatibleContractVersion(environment.summary.contractVersion, expectedContractVersion)) {
      current.push(environment);
    } else {
      staleEnvironments.push(environment.environmentId);
    }
  }

  const { ownedSourceKeys, duplicates } = claimSources(current);

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelAccumulator = new Map<
    string,
    { provider: UsageProviderKind; costUsd: number; totalTokens: number; records: number }
  >();
  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const hourlyAccumulator = new Map<
    string,
    {
      day: string;
      hourStart: string;
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const contributingEnvironments: EnvironmentId[] = [];

  for (const environment of current) {
    const { buckets, sessionsByProvider } = ownedContribution(environment, ownedSourceKeys);
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);

    for (const [providerKind, providerSessions] of sessionsByProvider) {
      sessions += providerSessions;
      if (providerSessions === 0) continue;
      const provider = providerAccumulator.get(providerKind) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.sessions += providerSessions;
      providerAccumulator.set(providerKind, provider);
    }

    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.costUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;
      providerAccumulator.set(bucket.provider, provider);

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        records: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.records += bucket.records;
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? {
        costUsd: 0,
        totalTokens: 0,
        byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
      };
      day.costUsd += bucket.costUsd;
      day.totalTokens += tokens;
      const dayProvider = day.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
      dayProvider.costUsd += bucket.costUsd;
      dayProvider.totalTokens += tokens;
      day.byProvider.set(bucket.provider, dayProvider);
      dailyAccumulator.set(bucket.day, day);

      if (bucket.hourStart !== undefined) {
        const hour = hourlyAccumulator.get(bucket.hourStart) ?? {
          day: bucket.day,
          hourStart: bucket.hourStart,
          costUsd: 0,
          totalTokens: 0,
          byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
        };
        hour.costUsd += bucket.costUsd;
        hour.totalTokens += tokens;
        const hourProvider = hour.byProvider.get(bucket.provider) ?? {
          costUsd: 0,
          totalTokens: 0,
        };
        hourProvider.costUsd += bucket.costUsd;
        hourProvider.totalTokens += tokens;
        hour.byProvider.set(bucket.provider, hourProvider);
        hourlyAccumulator.set(bucket.hourStart, hour);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      sessions: totals.sessions,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.entries()]
    .map(([key, totals]) => ({
      model: key.slice(key.indexOf(" ") + 1),
      provider: totals.provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, totals]) => ({
      day,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      byProvider: totals.byProvider,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const hourly: HourlyTotals[] = [...hourlyAccumulator.values()].sort((a, b) =>
    a.hourStart.localeCompare(b.hourStart),
  );

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers,
    models,
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    staleEnvironments,
  };
}
