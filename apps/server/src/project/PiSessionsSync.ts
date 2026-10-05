import {
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  resolveProviderInstanceEnabled,
  type AgentSessionImportResult,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PiSessionsClient from "../provider/PiSessionsClient.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolvePiAgentDir } from "../provider/pi/piPaths.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { importPreparedAgentThreads } from "./AgentSessionImporter.ts";
import * as PiSessionTranscript from "./PiSessionTranscript.ts";

export class PiSessionsSync extends Context.Service<
  PiSessionsSync,
  {
    readonly refresh: Effect.Effect<AgentSessionImportResult>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/project/PiSessionsSync") {}

const decodeConfig = Schema.decodeUnknownOption(PiSettings);
const decodeCursor = Schema.decodeUnknownOption(
  Schema.Struct({
    piSessionId: Schema.optional(Schema.String),
    piSessionFile: Schema.optional(Schema.String),
  }),
);
const make = Effect.gen(function* () {
  const client = yield* PiSessionsClient.PiSessionsClient;
  const transcripts = yield* PiSessionTranscript.PiSessionTranscript;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const settings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Capture the importer dependencies once; transports never acquire their own import runtime.
  const services =
    yield* Effect.context<Effect.Services<ReturnType<typeof importPreparedAgentThreads>>>();
  const identity = (value: string) => fs.realPath(value).pipe(Effect.orElseSucceed(() => null));
  let offset = 0;
  let result: AgentSessionImportResult = { importedCount: 0, skippedCount: 0 };
  let queued = false;
  const sweep = Effect.gen(function* () {
    result = { importedCount: 0, skippedCount: 0 };
    const listed = yield* client.list;
    const records = listed?.filter(
      (record) =>
        !record.live &&
        record.owner !== "t3" &&
        !record.t3 &&
        record.sessionFile !== undefined &&
        path.isAbsolute(record.sessionFile) &&
        record.agentDir !== undefined &&
        path.isAbsolute(record.agentDir) &&
        path.isAbsolute(record.cwd),
    );
    if (!records?.length) return;
    const config = yield* settings.getSettings;
    const projects = yield* snapshots.getProjectShells();
    const projectRoots = yield* Effect.forEach(projects, (project) =>
      identity(project.workspaceRoot).pipe(Effect.map((root) => ({ project, root }))),
    );
    const instances = Object.entries(config.providerInstances).filter(
      ([, instance]) => instance.driver === "pi" && resolveProviderInstanceEnabled(instance),
    );
    if (!Object.hasOwn(config.providerInstances, "pi") && config.providers.pi.enabled)
      instances.push([
        "pi",
        { driver: ProviderDriverKind.make("pi"), config: config.providers.pi },
      ]);
    const homes = yield* Effect.forEach(instances, ([id, instance]) =>
      Effect.gen(function* () {
        const pi = decodeConfig(instance.config ?? {});
        if (Option.isNone(pi)) return null;
        const home = yield* identity(
          resolvePiAgentDir(path, {
            agentDir: pi.value.agentDir,
            environment: mergeProviderInstanceEnvironment(instance.environment),
          }),
        );
        return home === null ? null : { id: ProviderInstanceId.make(id), home };
      }),
    );
    const bindings = yield* directory.listBindings();
    const boundIds = new Map<string, Set<ThreadId>>();
    const boundFiles = new Map<string, Set<ThreadId>>();
    const bind = (map: Map<string, Set<ThreadId>>, key: string, threadId: ThreadId) => {
      const ids = map.get(key) ?? new Set<ThreadId>();
      ids.add(threadId);
      map.set(key, ids);
    };
    const completedByProject = new Map<string, Set<ThreadId>>();
    for (const binding of bindings) {
      if (binding.provider !== "pi") continue;
      const cursor = decodeCursor(binding.resumeCursor);
      if (Option.isNone(cursor)) continue;
      if (cursor.value.piSessionId) bind(boundIds, cursor.value.piSessionId, binding.threadId);
      if (cursor.value.piSessionFile) {
        const file = yield* identity(cursor.value.piSessionFile);
        if (file) bind(boundFiles, file, binding.threadId);
      }
    }
    // Rotate the bounded window even when a corrupt/unknown session cannot be imported.
    const count = Math.min(records.length, 100);
    const start = offset % records.length;
    offset = (start + count) % records.length;
    for (let index = 0; index < count; index++) {
      const record = records[(start + index) % records.length]!;
      const file = yield* identity(record.sessionFile!);
      if (!file) continue;
      // Resolve the instance before deciding whether a stopped import cursor is a retry.
      const root = yield* identity(record.cwd);
      const matches = projectRoots.filter((entry) => root !== null && entry.root === root);
      if (matches.length !== 1) continue;
      const home = yield* identity(record.agentDir!);
      const owners = homes.filter(
        (entry) => entry !== null && home !== null && entry.home === home,
      );
      if (owners.length !== 1 || !owners[0]) continue;
      const project = matches[0]!.project;
      const threadId = ThreadId.make(`import:${owners[0].id}:${record.sessionId}`);
      const bound = [...(boundIds.get(record.sessionId) ?? []), ...(boundFiles.get(file) ?? [])];
      if (bound.some((id) => id !== threadId)) continue;
      let completed = completedByProject.get(project.id);
      if (!completed) {
        completed = new Set(
          (yield* snapshots.getImportedAgentSessionSources(project.id)).map(
            (entry) => entry.threadId,
          ),
        );
        completedByProject.set(project.id, completed);
      }
      if (completed.has(threadId)) continue;
      if (bound.length > 0) {
        if (bindings.find((binding) => binding.threadId === threadId)?.status !== "stopped")
          continue;
        // A previous import may have installed its stopped cursor before crashing.
        // The importer checks for real activity and never resurrects archived/deleted threads.
      }
      const outcome = yield* transcripts.read(record, owners[0].id, root!);
      if (!outcome) {
        result = { ...result, skippedCount: result.skippedCount + 1 };
        continue;
      }
      const imported = yield* importPreparedAgentThreads(
        { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
        [outcome],
      ).pipe(Effect.provideContext(services));
      result = {
        importedCount: result.importedCount + imported.importedCount,
        skippedCount: result.skippedCount + imported.skippedCount,
      };
      if (imported.importedCount > 0) {
        bind(boundIds, record.sessionId, threadId);
        bind(boundFiles, file, threadId);
        completed.add(threadId);
      }
    }
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Pi session import skipped", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          queued = false;
        }),
      ),
    ),
  );
  const refresh = Effect.gen(function* () {
    yield* Effect.uninterruptible(
      Effect.suspend(() => {
        if (queued) return Effect.void;
        queued = true;
        return worker.enqueue(undefined);
      }),
    );
    yield* worker.drain;
    return result;
  });
  let started = false;
  const start: PiSessionsSync["Service"]["start"] = () =>
    Effect.gen(function* () {
      if (started) return;
      started = true;
      yield* forkParked(refresh.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.asVoid));
    });
  return PiSessionsSync.of({ refresh, start, drain: worker.drain });
});

export const layer = Layer.effect(PiSessionsSync, make);
