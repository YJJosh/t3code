import { type ProviderInstanceId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";

const InventoryEntry = Schema.Struct({
  tools: Schema.Array(Schema.String),
  plugins: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
  lastSeen: Schema.Number,
});
const Inventory = Schema.Record(Schema.String, InventoryEntry);
const encode = Schema.encodeEffect(Schema.fromJsonString(Inventory));
type InventoryEntry = typeof InventoryEntry.Type;

export class ClaudeSessionInventory extends Context.Service<
  ClaudeSessionInventory,
  {
    readonly record: (
      instanceId: ProviderInstanceId,
      init: {
        readonly tools?: ReadonlyArray<string>;
        readonly plugins?: ReadonlyArray<{ readonly name: string; readonly path: string }>;
        readonly skills?: ReadonlyArray<string>;
      },
    ) => Effect.Effect<void>;
    readonly get: (instanceId: ProviderInstanceId) => Effect.Effect<InventoryEntry | undefined>;
  }
>()("t3/provider/ClaudeSessionInventory") {}

const union = (previous: ReadonlyArray<string>, next: ReadonlyArray<string>) =>
  [...new Set([...previous, ...next])].toSorted();

const pluginId = (plugin: { readonly name: string; readonly path: string }) => {
  if (plugin.name.includes("@")) return plugin.name;
  // Older init frames use a bare name; marketplace installs live in plugins/cache/<market>/<name>/<version>.
  const cached = /(?:^|\/)plugins\/cache\/([^/]+)\/([^/]+)\//.exec(
    plugin.path.replaceAll("\\", "/"),
  );
  return cached?.[2] === plugin.name ? `${plugin.name}@${cached[1]}` : undefined;
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.providerStatusCacheDir, "claude-session-inventory.json");
  const loaded = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Inventory))),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed({}),
    ),
    Effect.catch(() =>
      Effect.logWarning("Could not load Claude session inventory; starting empty").pipe(
        Effect.as({}),
      ),
    ),
  );
  const entries = new Map<string, InventoryEntry>(Object.entries(loaded));
  const changes = yield* Queue.sliding<void>(1);
  let revision = 0;
  let savedRevision = 0;
  const persist = Effect.fn("ClaudeSessionInventory.persist")(
    function* () {
      if (revision === savedRevision) return;
      const saving = revision;
      yield* writeFileStringAtomically({
        filePath,
        contents: yield* encode(Object.fromEntries(entries)),
      });
      savedRevision = saving;
    },
    Effect.catch(() => Effect.logWarning("Could not persist Claude session inventory")),
  );
  yield* Effect.addFinalizer(() => persist());
  yield* Stream.fromQueue(changes).pipe(
    Stream.debounce("1 second"),
    Stream.runForEach(() => persist()),
    Effect.forkScoped,
  );
  const record = Effect.fn("ClaudeSessionInventory.record")(function* (
    instanceId: ProviderInstanceId,
    init: Parameters<ClaudeSessionInventory["Service"]["record"]>[1],
  ) {
    const lastSeen = yield* Clock.currentTimeMillis;
    const previous = entries.get(instanceId);
    entries.set(instanceId, {
      tools: union(
        previous?.tools ?? [],
        (init.tools ?? []).filter((name) => !name.startsWith("mcp__")),
      ),
      plugins: union(
        previous?.plugins ?? [],
        (init.plugins ?? []).flatMap((plugin) => {
          const id = pluginId(plugin);
          return id === undefined ? [] : [id];
        }),
      ),
      skills: union(previous?.skills ?? [], init.skills ?? []),
      lastSeen,
    });
    revision++;
    yield* Queue.offer(changes, undefined);
  });
  const get = Effect.fn("ClaudeSessionInventory.get")(function* (instanceId: ProviderInstanceId) {
    return yield* Effect.sync(() => entries.get(instanceId));
  });
  return ClaudeSessionInventory.of({ record, get });
});

export const layer = Layer.effect(ClaudeSessionInventory, make);
