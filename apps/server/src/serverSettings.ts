import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProjectSettingsOverrides,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ResponseStreamingMode,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  globalIdleCompaction,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  applyServerSettingsPatch,
  deriveLegacyProjectOverrides,
  fallbackTextGenerationModelSelection,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import {
  readSecretFieldValues,
  sourceControlHostSecretName,
} from "./sourceControl/sourceControlHostSecrets.ts";

import {
  forkPiSecretMoves,
  mapSettingsSecrets,
  SECRET_REDACTED,
  type SettingsSecret,
} from "./settingsSecrets.ts";

import {
  hasForkPiSettings,
  jsonObject,
  renamePiPaths,
} from "./persistence/Migrations/dulli/002_DulliProviderIdentity.ts";

/** Raw migration: never send the fork config through upstream Pi's narrower schema.
 * An occupied destination is a startup error, not an implicit settings/secret merge.
 */
export function migrateForkPiSettings(raw: Record<string, unknown>) {
  const settings = structuredClone(raw);
  const instances = jsonObject(settings.providerInstances) ?? {};
  const legacy = jsonObject(settings.providers);
  const legacyPi = jsonObject(legacy?.pi);
  const canonicalPi = jsonObject(instances.pi);
  if (canonicalPi && canonicalPi.driver !== "pi") {
    throw new Error("Dulli migration conflict: the historical pi slot is owned by another driver.");
  }
  if (
    ((legacyPi || canonicalPi?.driver === "pi") && instances.dulli !== undefined) ||
    jsonObject(instances.dulli)?.driver === "pi"
  ) {
    throw new Error(
      "Dulli migration conflict: both pi and dulli provider slots exist. Preserve both configurations and resolve the destination before upgrading.",
    );
  }
  const secretMoves: Array<{ from: string; to: string }> = [];
  if (!canonicalPi && legacyPi) {
    instances.pi = { driver: "pi", config: legacyPi, enabled: legacyPi.enabled ?? true };
  }
  for (const [id, value] of Object.entries(instances)) {
    const instance = jsonObject(value);
    if (instance?.driver !== "pi") continue;
    const config = jsonObject(instance.config) ?? {};
    const environment = Array.isArray(instance.environment)
      ? instance.environment.flatMap((entry) => {
          const variable = jsonObject(entry);
          return typeof variable?.name === "string" ? [{ name: variable.name }] : [];
        })
      : [];
    secretMoves.push(...forkPiSecretMoves(id, config, environment));
    instances[id === "pi" ? "dulli" : id] = { ...instance, driver: "dulli" };
    if (id === "pi") delete instances.pi;
  }
  // The old fork enabled Pi even when its default config was omitted from disk.
  if (instances.dulli === undefined)
    instances.dulli = { driver: "dulli", enabled: true, config: {} };
  settings.providerInstances = instances;
  if (legacy) delete legacy.pi;
  const renameKey = (value: unknown) => {
    const map = jsonObject(value);
    if (!map || !("pi" in map)) return;
    if ("dulli" in map) throw new Error("Dulli migration conflict in instance-keyed settings.");
    map.dulli = map.pi;
    delete map.pi;
  };
  const selections = [
    "defaultModelSelection",
    "textGenerationModelSelection",
    "sourceControlWriterModelSelection",
    "reviewGuideModelSelection",
  ];
  const rewriteScope = (scope: Record<string, unknown>) => {
    renamePiPaths(
      scope,
      selections.flatMap((key) => [`${key}.instanceId`, `${key}.provider`]),
    );
    renamePiPaths(scope, ["favorites.*.provider"]);
    renameKey(scope.providerModelPreferences);
    renameKey(scope.loadBalancingWeights);
  };
  rewriteScope(settings);
  for (const value of Object.values(jsonObject(settings.projectSettingsOverrides) ?? {})) {
    const scope = jsonObject(value);
    if (!scope) continue;
    rewriteScope(scope);
    renameKey(scope.providerInstances);
  }
  return { settings, secretMoves };
}

export {
  resolveTextGenerationModelSelection,
  resolveReviewGuideModelSelection,
  resolveSourceControlWriterModelSelection,
} from "@t3tools/shared/serverSettings";

const decodeRawSettingsJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeRawSettingsJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Conflicting flags resolve to false to preserve user disables.
const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;
    // Leave malformed flags for driver schema validation rather than silently repairing them.
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
    ) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
      readonly enabled: boolean;
    };
    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);
    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }
  if (!changed) {
    return settings;
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
};

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.map((next) => withIdleCompaction(next, globalIdleCompaction(next))),
    Effect.map((next) => ({ ...next, ...deriveLegacyProjectOverrides(next) })),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  return mapSettingsSecrets(settings, (secret) =>
    secret.sensitive
      ? { value: "", redacted: secret.redacted || secret.value.length > 0 }
      : { value: secret.value, redacted: false },
  );
}

export function applyProviderInstanceMutation(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  if (mutation.operation === "upsert" || mutation.operation === "create") {
    providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    delete providerInstances[mutation.instanceId];
  }
  return { ...settings, providerInstances };
}

function ensureProviderInstanceMutationAllowed(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  if (
    mutation.operation === "create" &&
    settings.providerInstances[mutation.instanceId] !== undefined
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "create-provider-instance",
        providerInstanceId: mutation.instanceId,
      }),
    );
  }
  return Effect.void;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    readonly start: Effect.Effect<void, ServerSettingsError>;

    readonly ready: Effect.Effect<void, ServerSettingsError>;

    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Durable fork cutover signal. In-memory settings hosts may omit migration history. */
    readonly legacyPiProviderMigrated?: Effect.Effect<boolean, ServerSettingsError>;

    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;

    readonly streamChanges: Stream.Stream<ServerSettings>;

    /** Subscribe before reading a snapshot to retain changes before lazy stream startup. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = Effect.fn("serverSettings.makeTest")(function* (
  overrides: DeepPartial<ServerSettings> = {},
) {
  const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
    overrides;
  const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
  const initialSettings = yield* normalizeServerSettings({
    ...merged,
    ...(automaticGitFetchInterval !== undefined
      ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
      : {}),
    ...(providerHealthRefreshInterval !== undefined
      ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
      : {}),
  });
  const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
  const writeSemaphore = yield* Semaphore.make(1);
  const getSettings = Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider));

  const updateTestSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Ref.get(currentSettingsRef).pipe(
        Effect.flatMap(update),
        Effect.flatMap(normalizeServerSettings),
        Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
        Effect.map(resolveTextGenerationProvider),
      ),
    );

  return {
    start: Effect.void,
    ready: Effect.void,
    legacyPiProviderMigrated: Effect.succeed(false),
    getSettings,
    updateSettings: (patch) =>
      updateTestSettings((currentSettings) =>
        Effect.succeed(applyServerSettingsPatch(currentSettings, patch)),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateTestSettings((currentSettings) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(currentSettings, mutation, "test settings");
          const patched = applyServerSettingsPatch(currentSettings, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    withSettingsSnapshot: (use) =>
      writeSemaphore.withPermits(1)(getSettings.pipe(Effect.flatMap(use))),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  } satisfies ServerSettingsService["Service"];
});

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

// Accept retired token delivery only on load so one old value cannot reset all settings.
const PersistedResponseStreamingMode = Schema.Union([
  ResponseStreamingMode,
  Schema.Literal("token"),
]).pipe(
  Schema.decodeTo(
    ResponseStreamingMode,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "token" ? "paragraph" : mode),
      encode: (mode) => mode,
    }),
  ),
);
const ServerSettingsJson = fromLenientJson(
  Schema.Struct({
    ...ServerSettings.fields,
    responseStreamingMode: PersistedResponseStreamingMode.pipe(
      Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
    ),
    projectSettingsOverrides: Schema.Record(
      ProjectId,
      Schema.Struct({
        ...ProjectSettingsOverrides.fields,
        responseStreamingMode: Schema.optionalKey(PersistedResponseStreamingMode),
      }),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }),
);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);
const LegacyProviderSettingsJson = fromLenientJson(
  Schema.Struct({
    providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    includeT3CodeBranchPrefix: Schema.optionalKey(Schema.Boolean),
    useConventionalBranchPrefixes: Schema.optionalKey(Schema.Boolean),
    branchNamingMode: Schema.optionalKey(Schema.Unknown),
    bitbucket: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    github: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeLegacyProviderSettingsJsonExit = Schema.decodeUnknownExit(LegacyProviderSettingsJson);

const LEGACY_BITBUCKET_SECRET_NAMES: Readonly<Record<string, string>> = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
};
const legacyGitHubTokenSecretName = (host: string) =>
  `github-token-${Buffer.from(host.trim().toLowerCase(), "utf8").toString("base64url")}`;

function migrateLegacySourceControlSettings(
  settings: ServerSettings,
  legacy: {
    readonly bitbucket?: Readonly<Record<string, unknown>> | undefined;
    readonly github?: Readonly<Record<string, unknown>> | undefined;
  },
): {
  readonly settings: ServerSettings;
  readonly secretMoves: ReadonlyArray<{ readonly from: string; readonly to: string }>;
} {
  const sourceControlHosts = { ...settings.sourceControlHosts };
  const secretMoves: Array<{ readonly from: string; readonly to: string }> = [];
  if (legacy.bitbucket !== undefined && sourceControlHosts.bitbucket === undefined) {
    sourceControlHosts.bitbucket = legacy.bitbucket;
    for (const [field, from] of Object.entries(LEGACY_BITBUCKET_SECRET_NAMES)) {
      if (legacy.bitbucket[field] !== SECRET_REDACTED) continue;
      secretMoves.push({
        from,
        to: sourceControlHostSecretName({ kind: "bitbucket", field, serverHost: null }),
      });
    }
  }
  if (legacy.github !== undefined && sourceControlHosts.github === undefined) {
    sourceControlHosts.github = legacy.github;
    for (const [serverHost, value] of readSecretFieldValues(legacy.github.tokens)) {
      if (serverHost === null || value !== SECRET_REDACTED) continue;
      secretMoves.push({
        from: legacyGitHubTokenSecretName(serverHost),
        to: sourceControlHostSecretName({ kind: "github", field: "tokens", serverHost }),
      });
    }
  }
  return { settings: { ...settings, sourceControlHosts }, secretMoves };
}

const HISTORY_RESTORED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "opencode"].map((driver) => ProviderDriverKind.make(driver)),
);

function migrateLegacyProviderSettings(
  settings: ServerSettings,
  legacyProviders: Readonly<Record<string, unknown>>,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  const usedProviders = new Set<string>(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set<string>(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );

  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances) as Array<
    [ProviderInstanceId, ProviderInstanceConfig]
  >) {
    providerInstances[instanceId] =
      instance.enabled === undefined &&
      HISTORY_RESTORED_DRIVERS.has(instance.driver) &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance;
  }

  const legacyEntries = new Map(Object.entries(legacyProviders));
  for (const driver of HISTORY_RESTORED_DRIVERS) {
    if (!legacyEntries.has(driver)) legacyEntries.set(driver, {});
  }
  for (const [kind, blob] of legacyEntries) {
    if (!isProviderDriverKind(kind) || blob === null || typeof blob !== "object") continue;
    if (Array.isArray(blob)) continue;
    const driver = kind;
    const instanceId = defaultInstanceIdForDriver(driver);
    if (Object.hasOwn(providerInstances, instanceId)) continue;

    const { enabled: rawEnabled, ...config } = blob as Record<string, unknown>;
    const explicitEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
    const enabled =
      explicitEnabled ??
      (HISTORY_RESTORED_DRIVERS.has(driver) && usedProviders.has(driver) ? true : undefined);
    const driverDefault = resolveProviderInstanceEnabled({ driver, config: {} });
    if (Object.keys(config).length === 0 && (enabled === undefined || enabled === driverDefault)) {
      continue;
    }
    providerInstances[instanceId] = {
      driver,
      ...(enabled === undefined ? {} : { enabled }),
      config,
    } satisfies ProviderInstanceConfig;
  }

  return {
    ...settings,
    providerInstances,
  };
}

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

function selectionSupportsTextGeneration(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return settings.providerInstances[selection.instanceId]?.driver !== ACP_REGISTRY_DRIVER;
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection) &&
    selectionSupportsTextGeneration(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallback = fallbackTextGenerationModelSelection(
    settings.providerInstances,
    (instanceId, driver) =>
      resolveProviderInstanceEnabled(
        settings.providerInstances[instanceId] ?? { driver, config: {} },
      ),
    { defaultModelSelection: settings.defaultModelSelection },
  );
  return fallback === null ? settings : { ...settings, textGenerationModelSelection: fallback };
}

const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "textGenerationModelSelection",
  "fallbackModelSelection",
  "pullRequestMergeMethod",
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const decodeProjectScriptsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);

interface LegacyProjectSettingsRow {
  readonly projectId: string;
  readonly defaultModelSelection: string | null;
  readonly defaultThreadEnvMode: string | null;
  readonly autoPull: number;
  readonly scripts: string;
}

// projectSettingsFolded prevents restarts from undoing later UI resets.
function foldLegacyProjectSettings(
  settings: ServerSettings,
  rows: ReadonlyArray<LegacyProjectSettingsRow>,
): ServerSettings {
  if (settings.projectSettingsFolded) return settings;
  if (
    rows.length === 0 &&
    Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0 &&
    Object.keys(settings.projectAutoPullOverrides).length === 0 &&
    Object.keys(settings.projectScriptOverrides).length === 0
  ) {
    return settings;
  }
  const entries: Record<string, ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides,
  };
  const set = <K extends keyof ProjectSettingsOverrides>(
    projectId: string,
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) return;
    const entry = entries[projectId] ?? {};
    if (Object.hasOwn(entry, key)) return;
    entries[projectId] = { ...entry, [key]: value };
  };
  for (const [projectId, value] of Object.entries(settings.projectAgentBrowserAccessOverrides)) {
    set(projectId, "enableAgentBrowserAccess", value);
  }
  for (const [projectId, value] of Object.entries(settings.projectAutoPullOverrides)) {
    set(projectId, "defaultAutoPull", value);
  }
  // A stored null resets to machine defaults, so the project's aggregate scripts must not resurface.
  const resetScripts = new Set<string>();
  for (const [projectId, value] of Object.entries(settings.projectScriptOverrides)) {
    if (value === null) resetScripts.add(projectId);
    else set(projectId, "defaultProjectScripts", value);
  }
  for (const row of rows) {
    const model = decodeModelSelectionJson(row.defaultModelSelection ?? "null");
    if (Option.isSome(model) && model.value !== null) {
      set(row.projectId, "defaultModelSelection", model.value);
    }
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree") {
      set(row.projectId, "defaultThreadEnvMode", row.defaultThreadEnvMode);
    }
    if (row.autoPull === 1) set(row.projectId, "defaultAutoPull", true);
    const scripts = decodeProjectScriptsJson(row.scripts);
    if (Option.isSome(scripts) && scripts.value.length > 0 && !resetScripts.has(row.projectId)) {
      set(row.projectId, "defaultProjectScripts", scripts.value);
    }
  }
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => Object.keys(entry).length > 0),
  );
  return {
    ...settings,
    projectSettingsOverrides,
    projectSettingsFolded: true,
    ...deriveLegacyProjectOverrides({ projectSettingsOverrides }),
  };
}

const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {},
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const moveInlineSettingsSecrets = Effect.fn("serverSettings.moveInlineSettingsSecrets")(
    function* (settings: ServerSettings) {
      const pending: SettingsSecret[] = [];
      mapSettingsSecrets(settings, (secret) => {
        if (secret.kind === "field" && !secret.redacted && secret.value.length > 0) {
          pending.push(secret);
        }
        return secret;
      });
      const moved = new Set<string>();
      for (const secret of pending) {
        const stored = yield* secretStore
          .set(secret.secretName, textEncoder.encode(secret.value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a settings secret into the secret store").pipe(
                Effect.as(false),
              ),
            ),
          );
        if (stored) moved.add(secret.secretName);
      }
      if (moved.size === 0) return settings;
      return mapSettingsSecrets(settings, (secret) =>
        moved.has(secret.secretName) ? { value: "", redacted: true } : secret,
      );
    },
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings = DEFAULT_SERVER_SETTINGS;
    let legacyProviders: Readonly<Record<string, unknown>> | undefined;
    let hasLegacyBranchNaming = false;
    let legacySourceControl: Parameters<typeof migrateLegacySourceControlSettings>[1] = {};
    let parseFailure = Option.none<unknown>();

    {
      let raw = (yield* readConfigExists) ? yield* readRawConfig : "{}";
      // The database migration runs before this service and records the fork evidence
      // even when settings omitted Pi (the historical fork default).
      const markers = yield* sql<{ name: string }>`SELECT name FROM dulli_fork_migrations`.pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({ settingsPath, operation: "read-provider-history", cause }),
        ),
      );
      if (!markers.some((row) => row.name === "settings-checked")) {
        const parsed = yield* decodeRawSettingsJson(raw).pipe(Effect.option);
        if (Option.isSome(parsed) && jsonObject(parsed.value)) {
          const fork =
            markers.some((row) => row.name === "fork-detected") || hasForkPiSettings(parsed.value);
          if (fork) {
            const migration = yield* Effect.try(() =>
              migrateForkPiSettings(jsonObject(parsed.value)!),
            ).pipe(
              Effect.tapError(() =>
                Effect.logError(
                  "Dulli provider migration stopped: conflicting provider slots or instance-keyed preferences. Existing settings were not overwritten.",
                ),
              ),
              Effect.mapError(
                (cause) => new ServerSettingsError({ settingsPath, operation: "normalize", cause }),
              ),
            );
            for (const move of migration.secretMoves) {
              yield* Effect.gen(function* () {
                const secret = yield* secretStore.get(move.from);
                if (Option.isNone(secret)) return;
                const destination = yield* secretStore.get(move.to);
                if (
                  Option.isSome(destination) &&
                  !Buffer.from(destination.value).equals(Buffer.from(secret.value))
                ) {
                  return yield* new ServerSettingsError({
                    settingsPath,
                    operation: "write-secret",
                    cause: new Error("Dulli migration destination secret already exists."),
                  });
                }
                if (Option.isNone(destination)) yield* secretStore.set(move.to, secret.value);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({ settingsPath, operation: "write-secret", cause }),
                ),
              );
            }
            // Record evidence before the renamed file lands, so a crash cannot
            // leave migrated settings without the client cutover signal.
            yield* sql`INSERT OR IGNORE INTO dulli_fork_migrations VALUES ('fork-detected')`.pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({ settingsPath, operation: "write-file", cause }),
              ),
            );
            raw = `${yield* encodeRawSettingsJson(migration.settings).pipe(Effect.mapError((cause) => new ServerSettingsError({ settingsPath, operation: "write-file", cause })))}\n`;
            yield* writeFileStringAtomically({ filePath: settingsPath, contents: raw }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, pathService),
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({ settingsPath, operation: "write-file", cause }),
              ),
            );
            // Retain old secret names as recovery copies. They are not read after the
            // rename, and keeping them closes the file/SQLite crash window safely.
            yield* Effect.log("Migrated fork Pi settings and credentials to Dulli.");
          }
          yield* sql`INSERT OR IGNORE INTO dulli_fork_migrations VALUES ('settings-checked')`.pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "write-file", cause }),
            ),
          );
        }
      }
      const decoded = decodeServerSettingsJsonExit(raw);
      const legacySettings = decodeLegacyProviderSettingsJsonExit(raw);
      if (legacySettings._tag === "Success") {
        legacyProviders = legacySettings.value.providers;
        legacySourceControl = {
          bitbucket: legacySettings.value.bitbucket,
          github: legacySettings.value.github,
        };
      }
      if (decoded._tag === "Failure" || legacySettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : legacySettings;
        // The file may hold an opt-out we can no longer read; never resume threads on a guess.
        settings = { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterServerUpdate: false };
        if (failure._tag === "Failure") {
          parseFailure = Option.some(Cause.squash(failure.cause));
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        settings = decoded.value;
        const legacy = legacySettings.value;
        hasLegacyBranchNaming =
          legacy.includeT3CodeBranchPrefix !== undefined ||
          legacy.useConventionalBranchPrefixes !== undefined;
        // An explicitly chosen upstream policy wins. Only legacy files with
        // at least one old key are mapped; fresh installs use the fork default.
        if (hasLegacyBranchNaming && legacy.branchNamingMode === undefined) {
          const conventional = legacy.useConventionalBranchPrefixes ?? true;
          const namespace = legacy.includeT3CodeBranchPrefix ?? false;
          settings = {
            ...settings,
            ...(conventional && namespace
              ? {
                  branchNamingMode: "custom" as const,
                  branchNameInstructions:
                    "Name the branch t3code/<conventional type>/<short-kebab-name>, e.g. t3code/feat/add-search or t3code/fix/login-error.",
                }
              : conventional
                ? {
                    branchNamingMode: "semantic" as const,
                  }
                : {
                    branchNamingMode: "static" as const,
                    branchNamePrefix: namespace ? "t3code" : "",
                  }),
          };
        }
      }
    }
    // Settings saved by a server that kept the mode in `compactIdleThreads` move
    // it to `idleCompaction`, so that switch goes to clients as a boolean. The
    // defaults gain the field too, which tells clients this server reads modes.
    settings = withIdleCompaction(settings, globalIdleCompaction(settings));

    // A file that failed to decode must stay on disk for the user to repair.
    const settingsFileTrusted = Option.isNone(parseFailure);
    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const legacyProjectRows =
      settings.projectSettingsFolded || !settingsFileTrusted
        ? []
        : yield* sql<LegacyProjectSettingsRow>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection",
            default_thread_env_mode AS "defaultThreadEnvMode",
            auto_pull AS "autoPull",
            scripts_json AS "scripts"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `.pipe(
            NodeSqliteClient.readOnly,
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          );

    const loaded = foldProviderInstanceEnabledFlags(
      legacyProviders === undefined
        ? settings
        : migrateLegacyProviderSettings(settings, legacyProviders, providerHistory),
    );
    const folded = settingsFileTrusted
      ? foldLegacyProjectSettings(loaded, legacyProjectRows)
      : loaded;
    // Remove retired keys only after copying secrets and writing the new file; failures retry on next load.
    const legacySecretsCopied = yield* Effect.forEach(
      settingsFileTrusted
        ? migrateLegacySourceControlSettings(folded, legacySourceControl).secretMoves
        : [],
      (move) =>
        secretStore.get(move.from).pipe(
          Effect.flatMap((secret) =>
            Option.isNone(secret) ? Effect.void : secretStore.set(move.to, secret.value),
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("failed to copy a source control secret to its new name", {
              secretName: move.to,
            }).pipe(Effect.as(false)),
          ),
        ),
    ).pipe(Effect.map((copied) => copied.every(Boolean)));
    const hasLegacySourceControl =
      settingsFileTrusted &&
      legacySecretsCopied &&
      (legacySourceControl.bitbucket !== undefined || legacySourceControl.github !== undefined);
    const sourceControlMigration = hasLegacySourceControl
      ? migrateLegacySourceControlSettings(folded, legacySourceControl)
      : { settings: folded, secretMoves: [] };
    const migrated = settingsFileTrusted
      ? yield* moveInlineSettingsSecrets(sourceControlMigration.settings)
      : folded;
    if (
      migrated !== loaded ||
      (settingsFileTrusted && legacyProviders !== undefined) ||
      hasLegacySourceControl ||
      (settingsFileTrusted && hasLegacyBranchNaming)
    ) {
      yield* writeSettingsAtomically(migrated);
      for (const move of sourceControlMigration.secretMoves) {
        yield* secretStore.remove(move.from).pipe(Effect.ignore);
      }
    }
    return { settings: migrated, parseFailure };
  });

  const settingsCache = yield* Cache.makeWith((_key: typeof cacheKey) => loadSettingsFromDisk, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey).pipe(
    Effect.map((loaded) => loaded.settings),
  );
  const reloadSettings = Cache.invalidate(settingsCache, cacheKey).pipe(
    Effect.andThen(Cache.get(settingsCache, cacheKey)),
  );

  const materializeSettingsSecrets = Effect.fn("serverSettings.materializeSettingsSecrets")(
    function* (settings: ServerSettings): Effect.fn.Return<ServerSettings, ServerSettingsError> {
      const storedSecrets = new Map<string, string>();
      const pending = new Map<string, SettingsSecret>();
      mapSettingsSecrets(settings, (secret) => {
        if (secret.sensitive && secret.redacted) pending.set(secret.secretName, secret);
        return secret;
      });
      for (const secret of pending.values()) {
        const value = yield* secretStore.get(secret.secretName).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: secret.providerInstanceId,
                environmentVariable: secret.environmentVariable,
                cause,
              }),
          ),
        );
        storedSecrets.set(
          secret.secretName,
          Option.isSome(value) ? textDecoder.decode(value.value) : "",
        );
      }
      return mapSettingsSecrets(settings, (secret) => ({
        value:
          secret.sensitive && secret.redacted
            ? (storedSecrets.get(secret.secretName) ?? "")
            : secret.value,
        redacted: secret.sensitive && secret.kind === "environment" && secret.redacted,
      }));
    },
  );

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeSettingsSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize settings secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistSettingsSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.sync(() => {
      const previous = new Map<string, SettingsSecret>();
      mapSettingsSecrets(current, (secret) => {
        previous.set(secret.secretName, secret);
        return secret;
      });
      const changes: SecretChange[] = [];
      const nextSecretNames = new Set<string>();
      const settings = mapSettingsSecrets(next, (secret) => {
        const metadata = {
          secretName: secret.secretName,
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        };
        if (!secret.sensitive) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: secret.value, redacted: false };
        }
        const old = previous.get(secret.secretName);
        const inlineValue =
          old?.sensitive && !old.redacted && old.value.length > 0 ? old.value : undefined;
        const value = secret.redacted ? inlineValue : secret.value;
        if (value === undefined) {
          nextSecretNames.add(secret.secretName);
          return { value: "", redacted: true };
        }
        if (value.length === 0) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: "", redacted: false };
        }
        nextSecretNames.add(secret.secretName);
        changes.push({ ...metadata, kind: "write", value: textEncoder.encode(value) });
        return { value: "", redacted: true };
      });
      for (const secret of previous.values()) {
        if (!secret.sensitive || nextSecretNames.has(secret.secretName)) continue;
        if (changes.some((change) => change.secretName === secret.secretName)) continue;
        changes.push({
          kind: "remove",
          secretName: secret.secretName,
          operation: "remove-stale-secret",
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        });
      }
      return { settings, changes };
    });

  const rollbackSettingsSecretWrites = (
    writes: ReadonlyArray<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }>,
  ) =>
    Effect.forEach(
      writes.toReversed(),
      (write) =>
        (Option.isSome(write.previousValue)
          ? secretStore.set(write.secretName, write.previousValue.value)
          : secretStore.remove(write.secretName)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to roll back settings secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applySettingsSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackSettingsSecretWrites(applied));
    return Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const previousValue = yield* secretStore.get(change.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
          // A store operation may mutate before reporting an error (for example chmod after rename).
          applied.push({ ...change, previousValue });
          yield* (
            change.kind === "write"
              ? secretStore.set(change.secretName, change.value)
              : secretStore.remove(change.secretName)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: change.kind === "write" ? "write-secret" : change.operation,
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
        }),
      { discard: true },
    ).pipe(
      Effect.tapError(() => rollback),
      Effect.as(rollback),
    );
  };

  const updateAndPersistSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { settings: current, parseFailure } = yield* reloadSettings;
        if (Option.isSome(parseFailure)) {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "read-file",
            cause: parseFailure.value,
          });
        }
        const updated = yield* update(current);
        const persisted = yield* persistSettingsSecrets(current, updated);
        const next = yield* normalizeServerSettings(persisted.settings);
        const materialized = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const rollbackSecretChanges = yield* applySettingsSecretChanges(persisted.changes);
            const materializedExit = yield* Effect.exit(materializeSettingsSecrets(next));
            if (Exit.isFailure(materializedExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(materializedExit.cause);
            }
            const writeExit = yield* Effect.exit(writeSettingsAtomically(next));
            if (Exit.isFailure(writeExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(writeExit.cause);
            }
            return materializedExit.value;
          }),
        );
        yield* Cache.set(settingsCache, cacheKey, { settings: next, parseFailure: Option.none() });
        yield* emitChange(next);
        return resolveTextGenerationProvider(materialized);
      }),
    );

  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (use) =>
    writeSemaphore.withPermits(1)(
      getSettingsFromCache.pipe(
        Effect.flatMap(materializeSettingsSecrets),
        Effect.map(resolveTextGenerationProvider),
        Effect.flatMap(use),
      ),
    );

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const { settings } = yield* reloadSettings;
      yield* emitChange(settings);
    }),
  );

  const watchFileChanges = (filePath: string) => {
    const directory = pathService.dirname(filePath);
    const fileName = pathService.basename(filePath);
    const resolvedFilePath = pathService.resolve(filePath);
    return fs
      .watch(directory)
      .pipe(
        Stream.filter(
          (event) =>
            event.path === fileName ||
            event.path === filePath ||
            pathService.resolve(directory, event.path) === resolvedFilePath,
        ),
      );
  };

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Watch symlink targets' directories for rewrites; re-resolve link changes to follow repointing.
    const watchLinkTarget = Effect.gen(function* () {
      const linkTargetPath = yield* resolveSymlinkTarget(settingsPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
      if (linkTargetPath === pathService.resolve(settingsPath)) {
        return Option.none<string>();
      }
      yield* fs
        .makeDirectory(pathService.dirname(linkTargetPath), { recursive: true })
        .pipe(Effect.ignore({ log: true }));
      return Option.some(linkTargetPath);
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

    const initialLinkTarget = yield* watchLinkTarget;
    const linkTargetEvents = Stream.make(initialLinkTarget).pipe(
      Stream.concat(watchFileChanges(settingsPath).pipe(Stream.mapEffect(() => watchLinkTarget))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: (linkTargetPath) =>
            watchFileChanges(linkTargetPath).pipe(Stream.ignore({ log: true })),
        }),
      ),
    );

    // Saves emit multiple events; fs.watch may fire before content is flushed.
    const debouncedSettingsEvents = Stream.merge(
      watchFileChanges(settingsPath),
      linkTargetEvents,
    ).pipe(Stream.debounce(Duration.millis(100)));

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* reloadSettings;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    legacyPiProviderMigrated:
      sql`SELECT name FROM dulli_fork_migrations WHERE name = 'fork-detected'`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({ settingsPath, operation: "read-provider-history", cause }),
        ),
      ),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeSettingsSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch) =>
      updateAndPersistSettings((current) =>
        Effect.succeed(applyServerSettingsPatch(current, patch)),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateAndPersistSettings((current) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(current, mutation, settingsPath);
          const patched = applyServerSettingsPatch(current, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    withSettingsSnapshot,
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
