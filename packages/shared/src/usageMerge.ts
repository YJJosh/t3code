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
  /**
   * Records whose tokens are counted here but which contributed nothing to
   * `costUsd`. When it equals `records` the cost is unknown, not zero.
   */
  readonly unpricedRecords: number;
  readonly costShare: number;
}

/**
 * A model whose every record lacked rates has an unknown cost, not a zero one.
 * Clients must not present its `costUsd` as a real dollar figure.
 */
export function isModelCostUnknown(model: ModelTotals): boolean {
  return model.records > 0 && model.unpricedRecords >= model.records;
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

export interface UsageContractMismatch {
  readonly environmentId: EnvironmentId;
  readonly direction: "serverBehind" | "clientBehind";
  readonly contractVersion: number;
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
  readonly contractMismatches: readonly UsageContractMismatch[];
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

/** Forward-compatible decoding can remove unknown providers and shift source indexes. */
function bucketSourceIndex(summary: UsageSummary, bucket: UsageBucket): number | undefined {
  if (bucket.sourceIndex !== undefined) {
    const fingerprint = summary.sources[bucket.sourceIndex]?.fingerprint;
    if (
      fingerprint?.provider === bucket.provider &&
      (bucket.sourcePath === undefined || fingerprint.resolvedHomePath === bucket.sourcePath)
    )
      return bucket.sourceIndex;
  }
  if (bucket.sourcePath !== undefined)
    return summary.sources.findIndex(
      (source) =>
        source.fingerprint.provider === bucket.provider &&
        source.fingerprint.resolvedHomePath === bucket.sourcePath,
    );
  return bucket.sourceIndex;
}

function bucketsForSource(summary: UsageSummary, source: UsageSource): readonly UsageBucket[] {
  const sourceIndex = summary.sources.indexOf(source);
  const providerSources = summary.sources.filter(
    (entry) => entry.fingerprint.provider === source.fingerprint.provider,
  );
  return summary.buckets.filter(
    (bucket) =>
      bucket.provider === source.fingerprint.provider &&
      (bucketSourceIndex(summary, bucket) ?? (providerSources.length === 1 ? sourceIndex : -1)) ===
        sourceIndex,
  );
}

function sameScan(a: UsageSource, b: UsageSource): boolean {
  return a.scan?.maxDepth === b.scan?.maxDepth && a.scan?.filePattern === b.scan?.filePattern;
}

function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

/**
 * Decides which environment owns each physical transcript directory.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token.
 * Complete scans claim a fingerprint ahead of partial scans, then the most
 * recently read scan wins within each status. A newer partial scan can still
 * contribute cells absent from an older complete scan. Environment ids break
 * ties so the result is stable when summaries have the same read time.
 */
function claimSources(environments: readonly EnvironmentUsage[]) {
  const candidates: SourceClaim[] = environments.flatMap((environment) =>
    environment.summary.sources.flatMap((source, sourceIndex) =>
      source.status === "missing" ? [] : [{ environment, source, sourceIndex }],
    ),
  );
  const statusRank = { ok: 0, partial: 1, failed: 2, missing: 3 };
  candidates.sort((a, b) => {
    const statusOrder = statusRank[a.source.status] - statusRank[b.source.status];
    if (statusOrder) return statusOrder;
    // A total ordering puts broader roots first. Physical containment is still
    // checked before dropping anything; equally bounded roots use freshness.
    const pathOrder =
      normalizePortablePath(a.source.fingerprint.resolvedHomePath).split("/").filter(Boolean)
        .length -
      normalizePortablePath(b.source.fingerprint.resolvedHomePath).split("/").filter(Boolean)
        .length;
    if (pathOrder) return pathOrder;
    const patternOrder =
      Number(a.source.scan?.filePattern === "pi-subagent-session") -
      Number(b.source.scan?.filePattern === "pi-subagent-session");
    if (patternOrder) return patternOrder;
    const depthOrder = (b.source.scan?.maxDepth ?? -1) - (a.source.scan?.maxDepth ?? -1);
    if (depthOrder) return depthOrder;
    return (
      (Date.parse(b.environment.summary.readAt) || 0) -
        (Date.parse(a.environment.summary.readAt) || 0) ||
      a.environment.environmentId.localeCompare(b.environment.environmentId) ||
      a.sourceIndex - b.sourceIndex
    );
  });
  const claimed: SourceClaim[] = [];
  const ownedSourceKeys = new Set<string>();
  const supplementalBucketsByEnvironment = new Map<EnvironmentId, Set<UsageBucket>>();
  const sessionsBySource = new Map<string, number>();
  const seenByOwner = new Map<string, Set<string>>();
  const duplicates: string[] = [];
  for (const candidate of candidates) {
    const owner = claimed.find(
      (existing) =>
        existing.environment.environmentId !== candidate.environment.environmentId &&
        (sourceCovers(existing.source, candidate.source) ||
          (existing.source.fingerprint.volumeId.length > 0 &&
            sameScan(existing.source, candidate.source) &&
            fingerprintKey(existing.source.fingerprint) ===
              fingerprintKey(candidate.source.fingerprint))),
    );
    const key = sourceClaimKey(candidate.environment.environmentId, candidate.sourceIndex);
    if (!owner) {
      claimed.push(candidate);
      ownedSourceKeys.add(key);
      sessionsBySource.set(key, candidate.source.distinctSessions);
      continue;
    }
    duplicates.push(
      `${candidate.environment.label}: ${candidate.source.fingerprint.resolvedHomePath}`,
    );
    // Only identical scan coverage can supplement cells. A contained root may
    // have records assigned to other roots by its server's cross-file dedupe.
    if (
      candidate.source.status !== "partial" ||
      owner.source.status !== "ok" ||
      fingerprintKey(owner.source.fingerprint) !== fingerprintKey(candidate.source.fingerprint) ||
      !sameScan(owner.source, candidate.source) ||
      Date.parse(candidate.environment.summary.readAt) <=
        Date.parse(owner.environment.summary.readAt)
    )
      continue;
    const ownerKey = sourceClaimKey(owner.environment.environmentId, owner.sourceIndex);
    const seen =
      seenByOwner.get(ownerKey) ??
      new Set(bucketsForSource(owner.environment.summary, owner.source).map(bucketKey));
    seenByOwner.set(ownerKey, seen);
    const supplemental =
      supplementalBucketsByEnvironment.get(candidate.environment.environmentId) ??
      new Set<UsageBucket>();
    let added = false;
    for (const bucket of bucketsForSource(candidate.environment.summary, candidate.source)) {
      const cell = bucketKey(bucket);
      if (seen.has(cell)) continue;
      seen.add(cell);
      supplemental.add(bucket);
      added = true;
    }
    if (added) {
      supplementalBucketsByEnvironment.set(candidate.environment.environmentId, supplemental);
      sessionsBySource.set(
        ownerKey,
        Math.max(sessionsBySource.get(ownerKey) ?? 0, candidate.source.distinctSessions),
      );
    }
  }
  return { ownedSourceKeys, supplementalBucketsByEnvironment, sessionsBySource, duplicates };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownedSourceKeys: ReadonlySet<string>,
  supplementalBuckets: ReadonlySet<UsageBucket>,
  sessionsBySource: ReadonlyMap<string, number>,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSourceIndexes = new Set<number>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const [sourceIndex, source] of environment.summary.sources.entries()) {
    if (source.status === "missing") continue;
    const key = sourceClaimKey(environment.environmentId, sourceIndex);
    if (ownedSourceKeys.has(key)) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      ownedSourceIndexes.add(sourceIndex);
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) +
          (sessionsBySource.get(key) ?? source.distinctSessions),
      );
    }
  }
  return {
    buckets: environment.summary.buckets.filter((bucket) => {
      if (supplementalBuckets.has(bucket)) return true;
      const index = bucketSourceIndex(environment.summary, bucket);
      return index === undefined
        ? ownedProviders.has(bucket.provider)
        : ownedSourceIndexes.has(index) &&
            environment.summary.sources[index]?.fingerprint.provider === bucket.provider;
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

export function isCompatibleUsageContractVersion(version: number, expected: number): boolean {
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
  contractMismatches: [],
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against incompatible server code: rather
 * than blocking the page, its data is excluded and the mismatch direction is
 * reported so the UI can identify which side needs updating. Versions in
 * [{@link USAGE_MERGE_COMPATIBLE_SINCE}, expected] still merge, so an additive
 * provider expansion does not drop Claude/Codex totals from older servers.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  for (const environment of environments) {
    if (
      isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion)
    ) {
      current.push(environment);
    } else {
      contractMismatches.push({
        environmentId: environment.environmentId,
        direction:
          environment.summary.contractVersion < expectedContractVersion
            ? "serverBehind"
            : "clientBehind",
        contractVersion: environment.summary.contractVersion,
      });
    }
  }

  const { ownedSourceKeys, supplementalBucketsByEnvironment, sessionsBySource, duplicates } =
    claimSources(current);

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
    {
      provider: UsageProviderKind;
      costUsd: number;
      totalTokens: number;
      records: number;
      unpricedRecords: number;
    }
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
    const { buckets, sessionsByProvider } = ownedContribution(
      environment,
      ownedSourceKeys,
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set(),
      sessionsBySource,
    );
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
        unpricedRecords: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
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
      unpricedRecords: totals.unpricedRecords,
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
    contractMismatches,
  };
}
