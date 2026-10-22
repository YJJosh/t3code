import { forkParked } from "../serverActivation.ts";
import { recoverDulliUuidCursors } from "../orchestration-v2/legacy/DulliNativeContinuity.ts";
import {
  CommandId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderSessionId,
  ThreadId,
  OrchestrationV2ProviderThreadJson,
  resolveProviderInstanceEnabled,
  type AgentSessionImportResult,
} from "@t3tools/contracts";
import { DulliSettings } from "@t3tools/provider-dulli/settings";
import {
  PiSessionsClient,
  resolvePiAgentDir,
  type PiSessionInfo,
} from "@t3tools/provider-dulli/server";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PiSessionsSettlement from "../persistence/PiSessionsSettlement.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as PiSessionTranscript from "./PiSessionTranscript.ts";

export class PiSessionsSync extends Context.Service<
  PiSessionsSync,
  {
    readonly refresh: Effect.Effect<AgentSessionImportResult>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/project/PiSessionsSync") {}
const decodeConfig = Schema.decodeUnknownOption(DulliSettings);
const decodeBinding = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);

/** Concurrent disagreement keeps unfinished work visible, including daemon revision cycles. */
export function settlementTarget(input: {
  readonly baseline: {
    readonly daemonRev: number;
    readonly daemonSettled: boolean;
    readonly t3Settled: boolean;
  } | null;
  readonly daemonRev: number;
  readonly daemonSettled: boolean;
  readonly t3Settled: boolean;
  readonly imported: boolean;
}): boolean | null {
  const b = input.baseline;
  if (b && b.daemonRev > input.daemonRev) return null;
  if (!b) return input.imported ? input.daemonSettled : input.t3Settled;
  const daemonChanged = b.daemonRev !== input.daemonRev || b.daemonSettled !== input.daemonSettled;
  return daemonChanged
    ? b.t3Settled !== input.t3Settled
      ? input.daemonSettled && input.t3Settled
      : input.daemonSettled
    : input.t3Settled;
}

const make = Effect.gen(function* () {
  const client = yield* PiSessionsClient.PiSessionsClient;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const policies = yield* RuntimePolicy.RuntimePolicyV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const baselines = yield* PiSessionsSettlement.PiSessionsSettlement;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const transcripts = yield* PiSessionTranscript.PiSessionTranscript;
  const settings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnv = yield* HostProcess.Environment;
  const identity = (value: string) => fs.realPath(value).pipe(Effect.orElseSucceed(() => null));
  const enabledInstances = Effect.gen(function* () {
    const config = yield* settings.getSettings;
    // The registry enables an unconfigured default Dulli instance too.
    // Keep sharing/import and UUID recovery available without a saved settings slot;
    // an explicitly occupied or disabled slot still wins, exactly as in the registry.
    const instances: Record<string, ProviderInstanceConfig> = {
      dulli: { driver: ProviderDriverKind.make("dulli"), config: {} },
      ...config.providerInstances,
    };
    return Object.entries(instances).flatMap(([id, instance]) => {
      if (instance.driver !== "dulli" || !resolveProviderInstanceEnabled(instance)) return [];
      const parsed = decodeConfig(instance.config ?? {});
      return Option.isSome(parsed) && parsed.value.enabled
        ? [
            {
              id: ProviderInstanceId.make(id),
              config: parsed.value,
              env: {
                ...hostEnv,
                ...Object.fromEntries(
                  (instance.environment ?? []).map((entry) => [entry.name, entry.value]),
                ),
              },
            },
          ]
        : [];
    });
  });
  const headBranch = Effect.fn("PiSessionsSync.headBranch")(
    function* (dir: string) {
      const dotGit = path.join(dir, ".git");
      const info = yield* fs.stat(dotGit);
      let gitDir = dotGit;
      if (info.type !== "Directory") {
        const pointer = /^gitdir:\s*(.+)$/m.exec(yield* fs.readFileString(dotGit))?.[1]?.trim();
        if (!pointer) return null;
        gitDir = path.resolve(dir, pointer);
      }
      return (
        /^ref: refs\/heads\/(.+)$/m
          .exec(yield* fs.readFileString(path.join(gitDir, "HEAD")))?.[1]
          ?.trim() ?? null
      );
    },
    Effect.orElseSucceed(() => null),
  );
  const reconcile = Effect.fn("PiSessionsSync.reconcile")(function* (
    record: PiSessionInfo,
    threadId: ThreadId,
  ) {
    // Capture before reading the shell; the serialized orchestrator checks all thread events.
    const sequence = yield* sink.latestSequence({ threadId });
    const shell = yield* projections.getThread(threadId);
    if (shell.archivedAt !== null || shell.deletedAt !== null) return;
    if (record.settleRev !== undefined) {
      const link = { environmentId, threadId, sessionId: record.sessionId };
      const baseline = Option.getOrNull(yield* baselines.get(link));
      const t3Settled = shell.settledOverride === "settled";
      const daemonSettled = record.settledAt !== undefined;
      const target = settlementTarget({
        baseline,
        daemonRev: record.settleRev,
        daemonSettled,
        t3Settled,
        imported: shell.historyOrigin === "v1_import",
      });
      if (target === null) return;
      let revision = record.settleRev;
      if (daemonSettled !== target || t3Settled !== target) {
        const updated = yield* client.settle({
          sessionId: record.sessionId,
          settled: target,
          ifRev: revision,
        });
        if (
          updated?.settleRev === undefined ||
          (daemonSettled === target && updated.settleRev !== revision)
        )
          return;
        revision = updated.settleRev;
      }
      if (t3Settled !== target) {
        const commandId = CommandId.make(`pi-sessions:settle:${yield* crypto.randomUUIDv4()}`);
        yield* orchestrator.dispatch(
          target
            ? { type: "thread.settle", commandId, threadId, expectedSequence: sequence }
            : {
                type: "thread.unsettle",
                commandId,
                threadId,
                reason: "user",
                expectedSequence: sequence,
              },
        );
      }
      if (
        baseline?.daemonRev !== revision ||
        baseline.daemonSettled !== target ||
        baseline.t3Settled !== target
      )
        yield* baselines.set(link, {
          daemonRev: revision,
          daemonSettled: target,
          t3Settled: target,
        });
    }
    if (record.branch && shell.worktreePath && record.branch !== shell.branch) {
      const dir = yield* identity(shell.worktreePath);
      if (
        dir === null ||
        dir !== (yield* identity(record.cwd)) ||
        (yield* headBranch(dir)) !== record.branch
      )
        return;
      // Re-read after our own settlement dispatch, but retain the originally observed branch.
      const branchSequence = yield* sink.latestSequence({ threadId });
      const current = yield* projections.getThread(threadId);
      if (current.branch !== shell.branch || current.worktreePath !== shell.worktreePath) return;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`pi-sessions:branch:${yield* crypto.randomUUIDv4()}`),
        threadId,
        branch: record.branch,
        expectedSequence: branchSequence,
      });
    }
  });
  let latest: ReadonlyArray<PiSessionInfo> | null = null;
  let offset = 0;
  let recoveredHomes = "";
  const attachedSessions = new Map<ThreadId, ProviderSessionId>();
  let result: AgentSessionImportResult = { importedCount: 0, skippedCount: 0 };
  const sweep = Effect.gen(function* () {
    const instances = yield* enabledInstances;
    if (!instances.length) return;
    const homes = yield* Effect.forEach(instances, (instance) =>
      identity(
        resolvePiAgentDir(path, { agentDir: instance.config.agentDir, environment: instance.env }),
      ).pipe(Effect.map((home) => ({ ...instance, home }))),
    );
    const homePaths = homes.flatMap((entry) => (entry.home === null ? [] : [entry.home]));
    const homesKey = homePaths.slice().sort().join("\0");
    if (homesKey !== recoveredHomes) {
      recoveredHomes = homesKey;
      yield* recoverDulliUuidCursors(homePaths).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Legacy Dulli native continuity recovery skipped", { cause }),
        ),
      );
    }
    if (!latest?.length) return;
    const sharingInstances = instances.filter(
      (instance) => instance.config.piSessions && instance.config.shareWithTerminal,
    );
    const sharingHomes = homes.filter(
      (instance) => instance.config.piSessions && instance.config.shareWithTerminal,
    );
    if (!sharingInstances.length) return;
    const roots = yield* Effect.forEach(yield* projects.listShells(), (project) =>
      identity(project.workspaceRoot).pipe(Effect.map((root) => ({ project, root }))),
    );
    // Read only native bindings, not message histories or full shell snapshots.
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT p.payload_json FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id WHERE p.driver = 'dulli' AND json_extract(t.payload_json, '$.activeProviderThreadId') = p.provider_thread_id`;
    const bindings = rows.flatMap((row) => {
      const decoded = decodeBinding(row.payload_json);
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
    const files = yield* Effect.forEach(bindings, (binding) =>
      (binding.nativeThreadRef?.driver === "dulli" &&
      binding.nativeThreadRef.nativeId !== null &&
      path.isAbsolute(binding.nativeThreadRef.nativeId)
        ? identity(binding.nativeThreadRef.nativeId)
        : Effect.succeed(null)
      ).pipe(Effect.map((file) => ({ binding, file }))),
    );
    const listed = latest;
    const count = Math.min(listed.length, 100);
    const start = offset % listed.length;
    offset = (start + count) % listed.length;
    for (let n = 0; n < count; n++) {
      const record = listed[(start + n) % listed.length]!;
      yield* Effect.gen(function* () {
        if (record.t3 && record.t3.environment !== environmentId) return;
        if (
          !record.sessionFile ||
          !path.isAbsolute(record.sessionFile) ||
          !path.isAbsolute(record.cwd)
        )
          return;
        const file = yield* identity(record.sessionFile);
        if (!file) return;
        const matching = files.filter(
          (entry) => entry.file === file && entry.binding.appThreadId !== null,
        );
        if (matching.length > 1) return;
        const bound = matching[0]?.binding;
        if (bound?.appThreadId) {
          if (!sharingInstances.some((instance) => instance.id === bound.providerInstanceId))
            return;
          if (record.t3 && record.t3.thread !== bound.appThreadId) return;
          const shell = yield* projections.getThread(bound.appThreadId);
          if (shell.archivedAt !== null || shell.deletedAt !== null) return;
          if (!record.t3 && shell.historyOrigin !== "v1_import") return;
          if (!record.t3)
            yield* client.link({
              sessionId: record.sessionId,
              t3: { thread: bound.appThreadId, environment: environmentId },
            });
          yield* reconcile(record, bound.appThreadId);
          const knownSessionId = bound.providerSessionId ?? attachedSessions.get(bound.appThreadId);
          if (
            record.live &&
            record.owner === "daemon" &&
            record.t3?.environment === environmentId &&
            (knownSessionId === undefined || !(yield* sessions.isLive(knownSessionId)))
          ) {
            const runtimePolicy = yield* policies.resolve({
              thread: shell,
              modelSelection: shell.modelSelection,
            });
            const providerSessionId =
              knownSessionId ??
              (yield* ids.allocate.providerSession({
                providerInstanceId: bound.providerInstanceId,
                threadId: bound.appThreadId,
              }));
            const runtime = yield* sessions.open({
              threadId: bound.appThreadId,
              providerSessionId,
              modelSelection: shell.modelSelection,
              runtimePolicy,
              initialNativeThreadId: file,
              attachOnly: true,
            });
            yield* runtime
              .resumeThread({
                threadId: bound.appThreadId,
                providerThread: bound,
                modelSelection: shell.modelSelection,
                runtimePolicy,
              })
              .pipe(
                // A live but unregistered runtime would suppress every later
                // attach attempt. Closing its scope only detaches from shared Pi.
                Effect.onError(() =>
                  sessions.close(providerSessionId).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Dulli failed attach cleanup failed", {
                        providerSessionId,
                        cause,
                      }),
                    ),
                  ),
                ),
              );
            attachedSessions.set(bound.appThreadId, providerSessionId);
          }
          return;
        }
        if (
          record.owner === "t3" ||
          record.t3 ||
          !record.agentDir ||
          !path.isAbsolute(record.agentDir)
        )
          return;
        const home = yield* identity(record.agentDir);
        const owners = sharingHomes.filter((entry) => entry.home !== null && entry.home === home);
        if (owners.length !== 1) return;
        const root = yield* identity(record.cwd);
        if (root === null) return;
        let matches = roots.filter((entry) => entry.root === root);
        const inWorkspace =
          matches.length === 0 && path.basename(path.dirname(root)) === ".worktrees";
        if (inWorkspace)
          matches = roots.filter((entry) => entry.root === path.dirname(path.dirname(root)));
        if (matches.length !== 1) return;
        const project = matches[0]!.project;
        const read = yield* transcripts.read(record, owners[0]!.id, root);
        if (!read) {
          result = { importedCount: result.importedCount, skippedCount: result.skippedCount + 1 };
          return;
        }
        const outcome =
          read._tag === "Importable" && inWorkspace
            ? {
                ...read,
                thread: {
                  ...read.thread,
                  worktree: {
                    path: root,
                    branch:
                      (yield* headBranch(root)) === record.branch ? (record.branch ?? null) : null,
                  },
                },
              }
            : read;
        const imported = yield* importer.importPreparedAgentThreads(
          { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
          [outcome],
        );
        result = {
          importedCount: result.importedCount + imported.importedCount,
          skippedCount: result.skippedCount + imported.skippedCount,
        };
        if (imported.importedCount) {
          const legacyId = ThreadId.make(`import:pi:${record.sessionId}`);
          const legacy =
            owners[0]!.id === "dulli"
              ? yield* projections.getThread(legacyId).pipe(Effect.option)
              : Option.none();
          const threadId =
            Option.isSome(legacy) && legacy.value.providerInstanceId === owners[0]!.id
              ? legacyId
              : ThreadId.make(`import:${owners[0]!.id}:${record.sessionId}`);
          yield* client.link({
            sessionId: record.sessionId,
            t3: { thread: threadId, environment: environmentId },
          });
          yield* reconcile(record, threadId);
        }
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("Dulli shared session sync skipped", { cause })),
      );
    }
  });
  let queued = false;
  const worker = yield* makeDrainableWorker(() =>
    Effect.gen(function* () {
      queued = false;
      result = { importedCount: 0, skippedCount: 0 };
      const rounds = Math.max(1, Math.ceil((latest?.length ?? 0) / 100));
      for (let n = 0; n < rounds; n++) yield* sweep;
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Dulli shared sessions sweep failed", { cause })),
    ),
  );
  const enqueue = Effect.uninterruptible(
    Effect.suspend(() => {
      if (queued) return Effect.void;
      queued = true;
      return worker.enqueue(undefined);
    }),
  );
  const refresh = Effect.gen(function* () {
    latest = yield* client.list;
    yield* enqueue;
    yield* worker.drain;
    return result;
  });
  let started = false;
  const start: PiSessionsSync["Service"]["start"] = Effect.fn("PiSessionsSync.start")(function* () {
    if (started) return;
    started = true;
    const changes = yield* settings.subscribeChanges;
    let watching: Fiber.Fiber<void> | undefined;
    const configure = Effect.gen(function* () {
      const enabled = (yield* enabledInstances).some(
        (instance) => instance.config.piSessions && instance.config.shareWithTerminal,
      );
      if (!enabled && watching) {
        yield* Fiber.interrupt(watching);
        watching = undefined;
        latest = null;
      }
      if (enabled && !watching)
        watching = yield* client
          .watch((records) =>
            Effect.gen(function* () {
              latest = records;
              yield* enqueue;
            }),
          )
          .pipe(Effect.forkScoped);
      yield* enqueue;
    });
    yield* forkParked(
      Effect.gen(function* () {
        yield* configure.pipe(Effect.ignore);
        yield* Stream.runForEach(changes, () => configure.pipe(Effect.ignore));
      }),
    );
    yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      ["thread.settled", "thread.unsettled", "provider-session.detached"].includes(event.type)
        ? enqueue
        : Effect.void,
    ).pipe(Effect.ignore, Effect.forkScoped);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        started = false;
      }),
    );
  });
  return PiSessionsSync.of({ refresh, start, drain: worker.drain });
});
export const layer = Layer.effect(PiSessionsSync, make);
