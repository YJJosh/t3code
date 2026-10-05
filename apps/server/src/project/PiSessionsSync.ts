import {
  CommandId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  resolveProviderInstanceEnabled,
  type AgentSessionImportResult,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PiSessionsSettlement from "../persistence/PiSessionsSettlement.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
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
  const baselines = yield* PiSessionsSettlement.PiSessionsSettlement;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
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
  const importListed = Effect.fn(function* (listed: ReadonlyArray<PiSessionsClient.PiSessionInfo>) {
    const records = listed.filter(
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
  // Imports and settlement share the same list and worker, but independent rotating budgets.
  let settleOffset = 0;
  const reconcile = Effect.fn(function* (
    record: PiSessionsClient.PiSessionInfo,
    threadId: ThreadId,
    imported: boolean,
  ) {
    if (record.settleRev === undefined) return;
    const link = { environmentId, threadId, sessionId: record.sessionId };
    const saved = yield* baselines.get(link);
    const baseline = Option.getOrNull(saved);
    if (baseline !== null && baseline.daemonRev > record.settleRev) return;
    // Capture before reading the shell. Dispatch checks this aggregate inside its serialized
    // queue, so even a user change queued during the daemon round trip cannot be overwritten.
    const sequence = yield* engine.latestSequence;
    const shell = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(shell)) return;
    // The clients classify persisted settled state by this override (not turn completion).
    const t3Settled = shell.value.settledOverride === "settled";
    const daemonSettled = record.settledAt !== undefined;
    const daemonChanged =
      baseline !== null &&
      (record.settleRev !== baseline.daemonRev || daemonSettled !== baseline.daemonSettled);
    const t3Changed = baseline !== null && t3Settled !== baseline.t3Settled;
    let target = t3Settled;
    if (baseline === null) {
      if (imported) target = daemonSettled;
    } else if (daemonChanged) {
      // Concurrent disagreement keeps work visible. A daemon revision also detects
      // settle/unsettle cycles whose final boolean equals the previous baseline.
      target = t3Changed ? daemonSettled && t3Settled : daemonSettled;
    }
    let revision = record.settleRev;
    if (daemonSettled !== target || t3Settled !== target) {
      // Also confirm inbound changes with an idempotent CAS. A stale list must not undo
      // a newer daemon change while we were importing or waiting in the worker.
      const updated = yield* client.settle({
        sessionId: record.sessionId,
        settled: target,
        ifRev: revision,
      });
      if (updated?.settleRev === undefined) return;
      if (daemonSettled === target && updated.settleRev !== revision) return;
      revision = updated.settleRev;
    }
    if (t3Settled !== target) {
      const commandId = CommandId.make(`pi-sessions:settle:${yield* crypto.randomUUIDv4}`);
      yield* engine.dispatch(
        target
          ? { type: "thread.settle", commandId, threadId }
          : { type: "thread.unsettle", commandId, threadId, reason: "user" },
        { expectedSequence: sequence },
      );
    }
    // Acknowledge only the state we applied/read, never a later reread: an edit during
    // the request or baseline write must remain a change for the next round.
    if (
      baseline?.daemonRev !== revision ||
      baseline.daemonSettled !== target ||
      baseline.t3Settled !== target
    ) {
      yield* baselines.set(link, { daemonRev: revision, daemonSettled: target, t3Settled: target });
    }
  });
  const isolate = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Pi session sync skipped", { cause: Cause.pretty(cause) }),
      ),
    );
  const sweep = Effect.gen(function* () {
    result = { importedCount: 0, skippedCount: 0 };
    const listed = yield* client.list;
    if (!listed?.length) return;
    yield* isolate(importListed(listed));
    const bindings = (yield* directory.listBindings()).filter(
      (binding) => binding.provider === "pi",
    );
    const byThread = new Map(bindings.map((binding) => [binding.threadId, binding]));
    const bySession = new Map<string, typeof bindings>();
    for (const binding of bindings) {
      const cursor = decodeCursor(binding.resumeCursor);
      if (Option.isSome(cursor) && cursor.value.piSessionId) {
        const sessionId = cursor.value.piSessionId;
        bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), binding]);
      }
    }
    const count = Math.min(listed.length, 100);
    const start = settleOffset % listed.length;
    settleOffset = (start + count) % listed.length;
    const importedByProject = new Map<string, Set<ThreadId>>();
    for (let index = 0; index < count; index++) {
      const record = listed[(start + index) % listed.length]!;
      if (record.settleRev === undefined) continue;
      // Explicit links must name this environment. Never settle another environment's thread.
      if (record.t3 && record.t3.environment !== environmentId) continue;
      const candidates = record.t3
        ? [byThread.get(ThreadId.make(record.t3.thread))].filter((binding) => binding !== undefined)
        : (bySession.get(record.sessionId) ?? []);
      if (candidates.length !== 1) continue;
      const binding = candidates[0]!;
      const cursor = decodeCursor(binding.resumeCursor);
      if (
        Option.isSome(cursor) &&
        cursor.value.piSessionId &&
        cursor.value.piSessionId !== record.sessionId
      )
        continue;
      yield* isolate(
        Effect.gen(function* () {
          const shell = yield* snapshots.getThreadShellById(binding.threadId);
          if (Option.isNone(shell)) return;
          let imported = importedByProject.get(shell.value.projectId);
          if (!imported) {
            imported = new Set(
              (yield* snapshots.getImportedAgentSessionSources(shell.value.projectId))
                .filter((entry) => entry.source.provider === "pi")
                .map((entry) => entry.threadId),
            );
            importedByProject.set(shell.value.projectId, imported);
          }
          if (!record.t3 && !imported.has(binding.threadId)) return;
          yield* reconcile(record, binding.threadId, imported.has(binding.threadId));
        }),
      );
    }
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Pi session sync skipped", { cause: Cause.pretty(cause) }),
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
