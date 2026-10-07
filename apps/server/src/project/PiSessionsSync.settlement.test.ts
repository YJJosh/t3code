import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import type { ProviderSession, ProviderSessionStartInput } from "@t3tools/contracts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PiSessionsSettlement from "../persistence/PiSessionsSettlement.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as PiSessionsClient from "../provider/PiSessionsClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as PiSessionTranscript from "./PiSessionTranscript.ts";
import * as PiSessionsSync from "./PiSessionsSync.ts";

const now = "2026-08-24T10:00:00.000Z";
const environmentId = EnvironmentId.make("settle-test");
const projectId = ProjectId.make("project");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const watching = yield* Deferred.make<void>();
  const settledCalls = yield* Queue.unbounded<void>();
  let receive:
    | ((threads: ReadonlyArray<PiSessionsClient.PiSessionInfo>) => Effect.Effect<void>)
    | undefined;
  let sessions: ProviderSession[] = [];
  const starts: ProviderSessionStartInput[] = [];
  const records = new Map<string, PiSessionsClient.PiSessionInfo>();
  let available = true;
  let beforeSettle = Effect.void;
  let afterSettle = Effect.void;
  const requests: Array<Parameters<PiSessionsClient.PiSessionsClient["Service"]["settle"]>[0]> = [];
  const client = Layer.succeed(PiSessionsClient.PiSessionsClient, {
    link: () => Effect.void,
    watch: (onThreads) =>
      Effect.gen(function* () {
        receive = onThreads;
        yield* onThreads([...records.values()]);
        yield* Deferred.succeed(watching, undefined);
        return yield* Effect.never;
      }),
    list: Effect.sync(() => (available ? [...records.values()] : null)),
    settle: (input) =>
      Effect.gen(function* () {
        requests.push(input);
        yield* beforeSettle;
        const record = records.get(input.sessionId);
        if (!available || !record || record.settleRev === undefined) return null;
        if ((record.settledAt !== undefined) !== input.settled) {
          if (record.settleRev !== input.ifRev) return null;
          const { settledAt: _, ...rest } = record;
          records.set(input.sessionId, {
            ...rest,
            settleRev: record.settleRev + 1,
            ...(input.settled ? { settledAt: 3 } : {}),
          });
        }
        const result = records.get(input.sessionId)!;
        if (receive) yield* receive([...records.values()]);
        yield* Queue.offer(settledCalls, undefined);
        yield* afterSettle;
        return result;
      }),
  });
  const runtime = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
    PiSessionsSettlement.layer,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerConfig.layerTest(root, { prefix: "pi-settle-" })),
  );
  const context = yield* Layer.build(runtime);
  const engine = yield* OrchestrationEngineService.pipe(Effect.provideContext(context));
  const snapshots = yield* ProjectionSnapshotQuery.pipe(Effect.provideContext(context));
  const directory = yield* ProviderSessionDirectory.pipe(Effect.provideContext(context));
  const baselines = yield* PiSessionsSettlement.PiSessionsSettlement.pipe(
    Effect.provideContext(context),
  );
  const newWorker = Layer.build(
    PiSessionsSync.layer.pipe(
      Layer.provide(client),
      Layer.provide(
        Layer.mock(ProviderService)({
          listSessions: () => Effect.succeed(sessions),
          startSession: (_id, input) =>
            Effect.sync(() => {
              starts.push(input);
              const session: ProviderSession = {
                provider: ProviderDriverKind.make("pi"),
                providerInstanceId: ProviderInstanceId.make("pi"),
                threadId: input.threadId,
                runtimeMode: input.runtimeMode,
                status: "ready",
                createdAt: now,
                updatedAt: now,
              };
              sessions.push(session);
              return session;
            }),
        }),
      ),
      Layer.provide(PiSessionTranscript.layer),
      Layer.provide(
        ServerSettings.layerTest({ providers: { pi: { enabled: true, agentDir: root } } }),
      ),
      Layer.provide(
        Layer.succeed(ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  ).pipe(
    Effect.flatMap((workerContext) =>
      PiSessionsSync.PiSessionsSync.pipe(Effect.provideContext(workerContext)),
    ),
    Effect.provideContext(context),
  );
  const sync = yield* newWorker;
  let commandNumber = 0;
  const commandId = () => CommandId.make(`test:${++commandNumber}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId,
    title: "Project",
    workspaceRoot: root,
    defaultModelSelection: null,
    createdAt: now,
  });
  const local = (threadId: ThreadId, settled: boolean) =>
    engine.dispatch(
      settled
        ? { type: "thread.settle", commandId: commandId(), threadId }
        : { type: "thread.unsettle", commandId: commandId(), threadId, reason: "user" },
    );
  const remote = (sessionId: string, settled: boolean) => {
    const record = records.get(sessionId)!;
    if ((record.settledAt !== undefined) === settled) return;
    const { settledAt: _, ...rest } = record;
    records.set(sessionId, {
      ...rest,
      settleRev: (record.settleRev ?? 0) + 1,
      ...(settled ? { settledAt: 3 } : {}),
    });
  };
  const add = Effect.fn(function* (sessionId: string, imported = false, settled = false) {
    const threadId = ThreadId.make(imported ? `import:pi:${sessionId}` : sessionId);
    const sessionFile = `${root}/${sessionId}.jsonl`;
    records.set(sessionId, {
      sessionId,
      sessionFile,
      cwd: root,
      agentDir: root,
      owner: imported ? "foreground" : "t3",
      ...(!imported ? { t3: { thread: threadId, environment: environmentId } } : {}),
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      live: false,
      attached: 0,
      settleRev: 0,
      ...(settled ? { settledAt: 2 } : {}),
    });
    if (imported) {
      yield* fs.writeFileString(
        sessionFile,
        [
          { type: "session", version: 3, id: sessionId, cwd: root, timestamp: now },
          {
            type: "message",
            id: "u",
            parentId: null,
            timestamp: now,
            message: { role: "user", content: "Hello" },
          },
        ]
          .map((entry) => encode(entry))
          .join("\n") + "\n",
      );
    } else {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: commandId(),
        threadId,
        projectId,
        title: sessionId,
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: ProviderInstanceId.make("pi"),
        status: "stopped",
        resumeCursor: { piSessionId: sessionId, piSessionFile: sessionFile },
      });
    }
    return threadId;
  });
  const baseline = (threadId: ThreadId, sessionId: string = threadId) =>
    baselines.get({ environmentId, threadId, sessionId });
  const settled = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.map((shell) => Option.getOrThrow(shell).settledOverride === "settled"));
  return {
    root,
    snapshots,
    sync,
    starts,
    disconnected: () => {
      sessions = [];
    },
    watching: Deferred.await(watching),
    settledCall: Queue.take(settledCalls),
    push: Effect.suspend(() => (receive ? receive([...records.values()]) : Effect.void)),
    newWorker,
    add,
    local,
    remote,
    baseline,
    settled,
    records,
    requests,
    directory,
    engine,
    commandId,
    available: (value: boolean) => {
      available = value;
    },
    beforeSettle: (effect: Effect.Effect<void>) => {
      beforeSettle = effect;
    },
    afterSettle: (effect: Effect.Effect<void>) => {
      afterSettle = effect;
    },
  };
});

it.layer(NodeServices.layer)("Pi session settlement (real engine and SQLite)", (it) => {
  it.effect(
    "imports a Workler workspace chat with its folder and branch, and follows a renamed branch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const fs = yield* FileSystem.FileSystem;
        const workspace = `${f.root}/.worktrees/t3code-abcd1234`;
        yield* fs.makeDirectory(`${workspace}/.git`, { recursive: true });
        yield* fs.makeDirectory(`${f.root}/sub`);
        const setHead = (branch: string) =>
          fs.writeFileString(`${workspace}/.git/HEAD`, `ref: refs/heads/${branch}\n`);
        yield* setHead("t3code/abcd1234");
        const record = (sessionId: string, cwd: string, branch?: string) =>
          Effect.gen(function* () {
            const sessionFile = `${f.root}/${sessionId}.jsonl`;
            yield* fs.writeFileString(
              sessionFile,
              [
                { type: "session", version: 3, id: sessionId, cwd, timestamp: now },
                {
                  type: "message",
                  id: "u",
                  parentId: null,
                  timestamp: now,
                  message: { role: "user", content: "Hello" },
                },
              ]
                .map((entry) => encode(entry))
                .join("\n") + "\n",
            );
            f.records.set(sessionId, {
              sessionId,
              sessionFile,
              cwd,
              agentDir: f.root,
              owner: "foreground",
              status: "done",
              createdAt: 1,
              updatedAt: 2,
              live: false,
              attached: 0,
              settleRev: 0,
              ...(branch ? { branch } : {}),
            });
          });
        yield* record("wk", workspace, "t3code/abcd1234");
        // Only `<project>/.worktrees/<name>` belongs to the project, not any sub-folder.
        yield* record("sub", `${f.root}/sub`);
        yield* f.sync.start();
        yield* f.watching;
        yield* f.sync.drain;
        const threadId = ThreadId.make("import:pi:wk");
        const shell = () =>
          f.snapshots.getThreadShellById(threadId).pipe(Effect.map(Option.getOrThrow));
        expect(yield* shell()).toMatchObject({
          worktreePath: workspace,
          branch: "t3code/abcd1234",
        });
        const binding = Option.getOrThrow(yield* f.directory.getBinding(threadId));
        expect(binding.runtimePayload).toMatchObject({ cwd: workspace });
        expect(
          Option.isNone(yield* f.snapshots.getThreadShellById(ThreadId.make("import:pi:sub"))),
        ).toBe(true);

        // The agent renamed the branch: the workspace's HEAD and the record agree.
        yield* setHead("feature/hello");
        f.records.set("wk", { ...f.records.get("wk")!, branch: "feature/hello" });
        yield* f.push;
        yield* f.sync.drain;
        expect((yield* shell()).branch).toBe("feature/hello");

        // A stale record (HEAD says otherwise) never moves T3 back.
        f.records.set("wk", { ...f.records.get("wk")!, branch: "t3code/abcd1234" });
        yield* f.push;
        yield* f.sync.drain;
        expect((yield* shell()).branch).toBe("feature/hello");
      }).pipe(Effect.scoped),
  );

  for (const daemonSettled of [false, true]) {
    it.effect("settles both ways from pushes and T3 events without polling or ping-pong", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("events");
        yield* f.sync.start();
        yield* f.watching;
        yield* f.sync.drain;
        yield* f.local(id, true);
        yield* f.settledCall;
        yield* f.sync.drain;
        expect(f.records.get(id)?.settledAt).toBeDefined();
        f.remote(id, false);
        yield* f.push;
        yield* f.sync.drain;
        expect(yield* f.settled(id)).toBe(false);
        const count = f.requests.length;
        yield* f.push;
        yield* f.sync.drain;
        expect(f.requests).toHaveLength(count);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps only linked live daemon records attached, and reattaches after exit", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("live");
        f.records.set(id, { ...f.records.get(id)!, owner: "daemon", live: true });
        yield* f.sync.start();
        yield* f.watching;
        yield* f.sync.drain;
        expect(f.starts).toHaveLength(1);
        expect(f.starts[0]).toMatchObject({
          threadId: id,
          resumeCursor: { piSessionId: id, piSessionsAttach: true },
        });
        yield* f.push;
        yield* f.sync.drain;
        expect(f.starts).toHaveLength(1);
        f.disconnected();
        f.records.set(id, { ...f.records.get(id)!, live: false });
        yield* f.push;
        yield* f.sync.drain;
        expect(f.starts).toHaveLength(1);
        f.records.set(id, { ...f.records.get(id)!, live: true });
        yield* f.push;
        yield* f.sync.drain;
        expect(f.starts).toHaveLength(2);
      }).pipe(Effect.scoped),
    );

    it.effect(`initial import follows daemon (${daemonSettled}), not synthetic settlement`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("imported", true, daemonSettled);
        expect((yield* f.sync.refresh).importedCount).toBe(1);
        expect(yield* f.settled(id)).toBe(daemonSettled);
        expect(Option.getOrThrow(yield* f.baseline(id, "imported"))).toEqual({
          daemonRev: 0,
          daemonSettled,
          t3Settled: daemonSettled,
        });
        const count = f.requests.length;
        yield* f.sync.refresh;
        yield* f.sync.refresh;
        expect(f.requests).toHaveLength(count);
      }).pipe(Effect.scoped),
    );
  }

  for (const t3Settled of [false, true]) {
    it.effect(`initial native link follows T3 (${t3Settled})`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("native", false, !t3Settled);
        if (t3Settled) yield* f.local(id, true);
        yield* f.sync.refresh;
        expect(f.records.get(id)?.settledAt !== undefined).toBe(t3Settled);
        expect(Option.getOrThrow(yield* f.baseline(id))).toEqual({
          daemonRev: 1,
          daemonSettled: t3Settled,
          t3Settled,
        });
      }).pipe(Effect.scoped),
    );
  }

  for (const direction of ["daemon", "t3"] as const) {
    it.effect(`${direction} propagates settle and unsettle without ping-pong`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("linked");
        yield* f.sync.refresh;
        for (const state of [true, false]) {
          if (direction === "daemon") f.remote(id, state);
          else yield* f.local(id, state);
          yield* f.sync.refresh;
          expect(yield* f.settled(id)).toBe(state);
          expect(f.records.get(id)?.settledAt !== undefined).toBe(state);
          const count = f.requests.length;
          yield* f.sync.refresh;
          yield* (yield* f.newWorker).refresh;
          expect(f.requests).toHaveLength(count);
        }
      }).pipe(Effect.scoped),
    );
  }

  it.effect("both changed and agree, or only the revision moved, acknowledges without writes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const id = yield* f.add("agree");
      yield* f.sync.refresh;
      yield* f.local(id, true);
      f.remote(id, true);
      yield* f.sync.refresh;
      f.remote(id, false);
      f.remote(id, true);
      yield* f.sync.refresh;
      expect(f.requests).toHaveLength(0);
      expect(Option.getOrThrow(yield* f.baseline(id))).toEqual({
        daemonRev: 3,
        daemonSettled: true,
        t3Settled: true,
      });
    }).pipe(Effect.scoped),
  );

  for (const initiallySettled of [false, true]) {
    it.effect(`concurrent disagreement keeps both unsettled (baseline ${initiallySettled})`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("conflict", false, initiallySettled);
        if (initiallySettled) yield* f.local(id, true);
        yield* f.sync.refresh;
        yield* f.local(id, !initiallySettled);
        f.remote(id, !initiallySettled);
        f.remote(id, initiallySettled);
        yield* f.sync.refresh;
        expect(yield* f.settled(id)).toBe(false);
        expect(f.records.get(id)?.settledAt).toBeUndefined();
        expect(Option.getOrThrow(yield* f.baseline(id))).toMatchObject({
          daemonSettled: false,
          t3Settled: false,
        });
        const count = f.requests.length;
        yield* f.sync.refresh;
        expect(f.requests).toHaveLength(count);
      }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "a running T3 session rejects settlement; baseline stays and the next round retries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("blocked");
        yield* f.sync.refresh;
        const baseline = yield* f.baseline(id);
        const session = (status: "running" | "ready") =>
          f.engine.dispatch({
            type: "thread.session.set",
            commandId: f.commandId(),
            threadId: id,
            createdAt: now,
            session: {
              threadId: id,
              providerName: "pi",
              providerInstanceId: ProviderInstanceId.make("pi"),
              status,
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          });
        yield* session("running");
        f.remote(id, true);
        yield* f.sync.refresh;
        expect(yield* f.baseline(id)).toEqual(baseline);
        expect(yield* f.settled(id)).toBe(false);
        yield* session("ready");
        yield* f.sync.refresh;
        expect(yield* f.settled(id)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "daemon CAS conflict retains baseline, isolates other links, and re-reads next round",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.add("conflict");
        const other = yield* f.add("other");
        yield* f.sync.refresh;
        const baseline = yield* f.baseline(id);
        yield* f.local(id, true);
        yield* f.local(other, true);
        f.beforeSettle(
          Effect.sync(() => {
            f.remote(id, true);
            f.remote(id, false);
          }),
        );
        yield* f.sync.refresh;
        expect(yield* f.baseline(id)).toEqual(baseline);
        expect(f.records.get(other)?.settledAt).toBeDefined();
        f.beforeSettle(Effect.void);
        yield* f.sync.refresh;
        expect(yield* f.settled(id)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("offline, missing and older records leave the baseline and T3 untouched", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const id = yield* f.add("optional");
      yield* f.sync.refresh;
      const baseline = yield* f.baseline(id);
      yield* f.local(id, true);
      const record = f.records.get(id)!;
      f.available(false);
      yield* f.sync.refresh;
      f.available(true);
      f.records.delete(id);
      yield* f.sync.refresh;
      const { settleRev: _, ...oldRecord } = record;
      f.records.set(id, oldRecord);
      yield* f.sync.refresh;
      expect(yield* f.baseline(id)).toEqual(baseline);
      expect(yield* f.settled(id)).toBe(true);
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a newer T3 edit during inbound confirmation is not overwritten", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const id = yield* f.add("race");
      yield* f.sync.refresh;
      const baseline = yield* f.baseline(id);
      f.remote(id, true);
      f.beforeSettle(f.local(id, false).pipe(Effect.asVoid, Effect.orDie));
      yield* f.sync.refresh;
      expect(yield* f.settled(id)).toBe(false);
      expect(yield* f.baseline(id)).toEqual(baseline);
    }).pipe(Effect.scoped),
  );

  it.effect("a T3 edit during outbound IO remains a change after the baseline write", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const id = yield* f.add("race");
      yield* f.sync.refresh;
      yield* f.local(id, true);
      f.afterSettle(f.local(id, false).pipe(Effect.asVoid, Effect.orDie));
      yield* f.sync.refresh;
      expect(Option.getOrThrow(yield* f.baseline(id)).t3Settled).toBe(true);
      expect(yield* f.settled(id)).toBe(false);
      f.afterSettle(Effect.void);
      yield* f.sync.refresh;
      expect(f.records.get(id)?.settledAt).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("a newer daemon state during inbound confirmation is not overwritten", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const id = yield* f.add("daemon-race");
      yield* f.sync.refresh;
      const baseline = yield* f.baseline(id);
      f.remote(id, true);
      f.beforeSettle(Effect.sync(() => f.remote(id, false)));
      yield* f.sync.refresh;
      expect(yield* f.settled(id)).toBe(false);
      expect(yield* f.baseline(id)).toEqual(baseline);
      f.beforeSettle(Effect.void);
      yield* f.sync.refresh;
      expect(Option.getOrThrow(yield* f.baseline(id)).daemonRev).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds settlement work and rotates past the first hundred records", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (let index = 0; index < 101; index++) yield* f.add(`native-${index}`, false, true);
      yield* f.sync.refresh;
      expect(f.requests).toHaveLength(101);
      expect(Option.isSome(yield* f.baseline(ThreadId.make("native-100")))).toBe(true);
      yield* f.sync.refresh;
      expect(f.requests).toHaveLength(101);
      expect(Option.isSome(yield* f.baseline(ThreadId.make("native-100")))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("does not touch another environment or an unlinked native binding", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const kind of ["foreign", "unlinked"]) {
        const id = yield* f.add(kind, false, true);
        const { t3: _, ...record } = f.records.get(id)!;
        f.records.set(
          id,
          kind === "foreign" ? { ...record, t3: { thread: id, environment: "other" } } : record,
        );
      }
      yield* f.sync.refresh;
      expect(f.requests).toHaveLength(0);
      expect(Option.isNone(yield* f.baseline(ThreadId.make("foreign")))).toBe(true);
    }).pipe(Effect.scoped),
  );
});
