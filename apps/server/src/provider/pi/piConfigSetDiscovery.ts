import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolvePiAgentDir, type ResolvePiAgentDirOptions } from "./piPaths.ts";
import {
  discoverPiProfileChoices,
  parsePiProfileChoices,
  type PiProfileChoice,
} from "./piProfileDiscovery.ts";

export class PiConfigSetError extends Schema.TaggedError<PiConfigSetError>()("PiConfigSetError", {
  message: Schema.String,
}) {}

export const PI_DEFAULT_CONFIG_SET = "__providerDefault";
const SetName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/));
const decodeSetName = Schema.decodeOption(SetName);
const Registry = Schema.Struct({
  version: Schema.optional(Schema.Literal(1)),
  active: Schema.optional(Schema.String),
  sets: Schema.Record(
    SetName,
    Schema.Struct({
      path: Schema.NonEmptyString,
      description: Schema.optional(Schema.String),
      remote: Schema.optional(
        Schema.Struct({
          source: Schema.NonEmptyString,
          mount: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeRegistry = Schema.decodeUnknownOption(Schema.fromJsonString(Registry));

export interface PiConfigSetSelection {
  readonly name: string;
  readonly directory: string;
  readonly root: string;
  readonly registryPath: string;
}

export interface PiConfigSet extends PiConfigSetSelection {
  readonly description?: string;
  readonly available: boolean;
  readonly remote: boolean;
}

/** Read-only PM-compatible selection. Never mount, sync, or switch the global link. */
export const discoverPiConfigSets = Effect.fn("discoverPiConfigSets")(
  function* (options: ResolvePiAgentDirOptions) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const env = options.environment ?? process.env;
    const agentDir = paths.resolve(resolvePiAgentDir(paths, options));
    const expand = (value: string) =>
      paths.resolve(
        resolvePiAgentDir(paths, {
          agentDir: value,
          environment: env,
        }),
      );
    const canonical = (value: string) =>
      fs.realPath(value).pipe(Effect.orElseSucceed(() => paths.resolve(value)));
    const actualDir = yield* canonical(agentDir);
    const boundSession =
      env.PI_CONFIG_SET_DIR &&
      env.PI_CONFIG_SET_ROOT &&
      env.PI_CONFIG_SET_NAME &&
      paths.isAbsolute(env.PI_CONFIG_SET_DIR) &&
      paths.isAbsolute(env.PI_CONFIG_SET_ROOT) &&
      Option.isSome(decodeSetName(env.PI_CONFIG_SET_NAME)) &&
      (yield* canonical(env.PI_CONFIG_SET_DIR)) === actualDir &&
      env.PI_CONFIG_SET_REGISTRY &&
      paths.isAbsolute(env.PI_CONFIG_SET_REGISTRY) &&
      (yield* canonical(paths.dirname(env.PI_CONFIG_SET_REGISTRY))) ===
        (yield* canonical(env.PI_CONFIG_SET_ROOT));
    // Explicit registry overrides also support ordinary (not yet pinned) server launches.
    const registryPath = expand(
      (!env.PI_CONFIG_SET_NAME || boundSession ? env.PI_CONFIG_SET_REGISTRY?.trim() : undefined) ||
        paths.join(
          boundSession
            ? env.PI_CONFIG_SET_ROOT || paths.dirname(agentDir)
            : paths.dirname(agentDir),
          "config-sets.json",
        ),
    );
    const root = yield* canonical(paths.dirname(registryPath));
    const empty = { sets: [] as ReadonlyArray<PiConfigSet>, defaultName: PI_DEFAULT_CONFIG_SET };
    if (env.PI_CONFIG_REPO?.trim()) return empty;
    const contents = yield* fs.readFileString(registryPath).pipe(Effect.orElseSucceed(() => ""));
    const decoded = decodeRegistry(contents);
    if (Option.isNone(decoded)) return empty;
    const sets = yield* Effect.forEach(
      Object.entries(decoded.value.sets),
      ([name, set]) =>
        Effect.gen(function* () {
          // Launcher paths are absolute or home-relative; relative paths are not safe homes.
          if (!paths.isAbsolute(set.path) && !set.path.startsWith("~/")) return undefined;
          const directory = yield* canonical(expand(set.path));
          const available = yield* Effect.gen(function* () {
            const info = yield* fs.stat(directory);
            if (info.type !== "Directory") return false;
            if (!set.remote) return true;
            const source = set.remote.source.trim();
            const networkSource = /^[^/]+:/.test(source) && !/^[A-Za-z]:/.test(source);
            const mount = networkSource
              ? expand(set.remote.mount || paths.join(root, "mnt", name))
              : expand(source);
            const entries = yield* fs.readDirectory(mount);
            if (entries.length === 0) return false;
            if (networkSource) {
              const info = yield* fs.stat(mount);
              const parent = yield* fs.stat(paths.dirname(mount));
              if (info.type !== "Directory" || info.dev === parent.dev) return false;
            }
            // Refuse broken shared settings links even if local extensions remain cached.
            yield* fs.readFileString(paths.join(directory, "settings.json"));
            return true;
          }).pipe(
            Effect.timeoutOption("4 seconds"),
            Effect.map(Option.getOrElse(() => false)),
            Effect.orElseSucceed(() => false),
          );
          return {
            name,
            directory,
            root,
            registryPath,
            available,
            remote: Boolean(set.remote),
            ...(set.description ? { description: set.description } : {}),
          } satisfies PiConfigSet;
        }),
      { concurrency: 4 },
    );
    if (sets.some((set) => set === undefined)) return empty;
    const validSets = sets
      .filter((set): set is PiConfigSet => set !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
    // PM treats the link/resolved home, not informational registry.active, as truth.
    const defaultName =
      validSets.find((set) => set.directory === actualDir)?.name ?? PI_DEFAULT_CONFIG_SET;
    return { sets: validSets, defaultName };
  },
  Effect.timeoutOption("5 seconds"),
  Effect.map(
    Option.getOrElse(() => ({
      sets: [] as ReadonlyArray<PiConfigSet>,
      defaultName: PI_DEFAULT_CONFIG_SET,
    })),
  ),
);

/** Union keeps model options stable when changing sets; names may have set-local meanings. */
export const discoverPiConfigSetProfiles = Effect.fn("discoverPiConfigSetProfiles")(function* (
  options: ResolvePiAgentDirOptions & { readonly configuredProfile?: string },
  discovery: { readonly sets: ReadonlyArray<PiConfigSet>; readonly defaultName: string },
) {
  const defaultSet = discovery.sets.find((set) => set.name === discovery.defaultName);
  const defaults = yield* discoverPiProfileChoices({
    ...options,
    agentDir: defaultSet?.directory ?? options.agentDir,
  }).pipe(
    Effect.timeoutOption("1 second"),
    Effect.map(Option.getOrElse(() => parsePiProfileChoices(undefined, options.configuredProfile))),
  );
  const profiles = new Map<string, PiProfileChoice>(
    defaults.map((profile) => [profile.id, profile]),
  );
  const otherProfiles = yield* Effect.forEach(
    discovery.sets.filter((set) => set.available && set !== defaultSet),
    (set) =>
      discoverPiProfileChoices({ ...options, agentDir: set.directory }).pipe(
        Effect.timeoutOption("1 second"),
        Effect.map(Option.getOrElse(() => [])),
      ),
    { concurrency: 4 },
  ).pipe(Effect.timeoutOption("4 seconds"), Effect.map(Option.getOrElse(() => [])));
  for (const choices of otherProfiles) {
    for (const { isDefault: _, ...profile } of choices) {
      if (!profiles.has(profile.id)) profiles.set(profile.id, profile);
    }
  }
  return [...profiles.values()].sort((a, b) => a.label.localeCompare(b.label));
});

export const resolvePiSessionConfigSet = Effect.fn("resolvePiSessionConfigSet")(function* (
  options: ResolvePiAgentDirOptions,
  name: string | undefined,
) {
  const discovery = yield* discoverPiConfigSets(options);
  const selectedName = name || discovery.defaultName;
  if (selectedName === PI_DEFAULT_CONFIG_SET) return undefined;
  const set = discovery.sets.find((set) => set.name === selectedName);
  if (!set)
    return yield* new PiConfigSetError({
      message: `Pi config set "${selectedName}" is no longer registered. Choose another config set.`,
    });
  if (!set.available)
    return yield* new PiConfigSetError({
      message: set.remote
        ? `Pi config set "${set.name}" is missing or its shared folder is unmounted. Mount and synchronize it separately before starting the thread.`
        : `Pi config set "${set.name}" directory is missing: ${set.directory}`,
    });
  return { ...set, providerDefaultName: discovery.defaultName };
});
