import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as PiSessionsSettlement from "../persistence/PiSessionsSettlement.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as PiSessionsClient from "../provider/PiSessionsClient.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as PiSessionTranscript from "./PiSessionTranscript.ts";
import * as PiSessionsSync from "./PiSessionsSync.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const timestamp = "2026-08-24T10:00:00.000Z";
const fixture = Effect.fn(function* (mapping?: "custom" | "ambiguous" | "disabled") {
  const fs = yield* FileSystem.FileSystem;
  const temp = yield* fs.makeTempDirectoryScoped();
  const root = yield* fs.realPath(temp);
  const agentDir = `${root}/agent`;
  yield* fs.makeDirectory(agentDir);
  const project: OrchestrationProjectShell = {
    id: ProjectId.make("project"),
    title: "Project",
    workspaceRoot: root,
    createdAt: timestamp,
    updatedAt: timestamp,
    scripts: [],
    defaultModelSelection: null,
  };
  const completed: Array<{
    threadId: ThreadId;
    source: import("@t3tools/contracts").AgentSessionImportSource;
  }> = [];
  const commands: OrchestrationCommand[] = [];
  const bindings = new Map<ThreadId, ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>();
  const requests = yield* Queue.unbounded<void>();
  const pushed = yield* PubSub.unbounded<ReadonlyArray<PiSessionsClient.PiSessionInfo>>();
  const links: Array<{ sessionId: string; t3: { thread: string; environment: string } }> = [];
  let records: readonly PiSessionsClient.PiSessionInfo[] | null = null;
  let listGate: Effect.Effect<void> = Effect.void;
  let calls = 0;
  const external = Layer.mergeAll(
    Layer.mock(ProviderService)({ listSessions: () => Effect.succeed([]) }),
    Layer.mock(PiSessionsSettlement.PiSessionsSettlement)({}),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Layer.succeed(PiSessionsClient.PiSessionsClient, {
      link: (link) =>
        Effect.sync(() => {
          links.push(link);
        }),
      watch: (receive) =>
        Effect.gen(function* () {
          const updates = yield* PubSub.subscribe(pushed);
          yield* Queue.offer(requests, undefined);
          yield* receive(records ?? []);
          yield* Stream.runForEach(Stream.fromSubscription(updates), receive);
        }),
      settle: () => Effect.succeed(null),
      list: Effect.gen(function* () {
        calls++;
        yield* Queue.offer(requests, undefined);
        yield* listGate;
        return records;
      }),
    }),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getProjectShells: () => Effect.succeed([project]),
      getProjectShellById: () => Effect.succeedSome(project),
      getThreadDetailById: () => Effect.succeedNone,
      getImportedAgentSessionSources: () => Effect.succeed(completed),
    }),
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
    }),
    Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
      listBindings: () => Effect.succeed([...bindings.values()]),
      getBinding: (id) => Effect.succeed(Option.fromUndefinedOr(bindings.get(id))),
      upsert: (binding) =>
        Effect.sync(() => {
          bindings.set(binding.threadId, { ...binding, lastSeenAt: timestamp });
        }),
      recordImportedTranscript: (entry) =>
        Effect.sync(() => {
          completed.push(entry);
        }),
    }),
    ServerSettings.layerTest({
      providers: { pi: { enabled: mapping !== "custom" && mapping !== "disabled", agentDir } },
      ...(mapping === "custom" || mapping === "ambiguous"
        ? {
            providerInstances: {
              [ProviderInstanceId.make("pi-custom")]: {
                driver: ProviderDriverKind.make("pi"),
                config: { agentDir, enabled: true },
              },
            },
          }
        : {}),
    }),
  );
  const context = yield* Layer.build(
    PiSessionsSync.layer.pipe(Layer.provide(external), Layer.provide(PiSessionTranscript.layer)),
  );
  const sync = yield* PiSessionsSync.PiSessionsSync.pipe(Effect.provideContext(context));
  const createRecord = Effect.fn(function* (
    sessionId: string,
    override: Partial<PiSessionsClient.PiSessionInfo> = {},
  ) {
    const sessionFile = `${root}/${sessionId}.jsonl`;
    yield* fs.writeFileString(
      sessionFile,
      [
        { type: "session", version: 3, id: sessionId, cwd: root, timestamp },
        {
          type: "message",
          id: "u",
          parentId: null,
          timestamp,
          message: { role: "user", content: `prompt ${sessionId}` },
        },
      ]
        .map((value) => encode(value))
        .join("\n") + "\n",
    );
    return {
      sessionId,
      sessionFile,
      cwd: root,
      agentDir,
      owner: "foreground",
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      attached: 0,
      live: false,
      ...override,
    } satisfies PiSessionsClient.PiSessionInfo;
  });
  return {
    root,
    links,
    pushed,
    fs,
    sync,
    commands,
    bindings,
    createRecord,
    requests,
    calls: () => calls,
    setRecords: (value: typeof records) => {
      records = value;
    },
    setGate: (gate: Effect.Effect<void>) => {
      listGate = gate;
    },
  };
});

it.layer(NodeServices.layer)("PiSessionsSync", (it) => {
  for (const mapping of ["custom", "ambiguous", "disabled"] as const) {
    it.effect(`maps provider instances conservatively: ${mapping}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(mapping);
        f.setRecords([yield* f.createRecord("mapped")]);
        expect((yield* f.sync.refresh).importedCount).toBe(mapping === "custom" ? 1 : 0);
        if (mapping === "custom")
          expect(f.commands[0]).toMatchObject({
            type: "thread.create",
            modelSelection: { instanceId: "pi-custom" },
          });
      }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "matches project realpaths and dedupes stopped file-only bindings through aliases",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const alias = `${f.root}/project-alias`;
        yield* f.fs.symlink(f.root, alias);
        const good = yield* f.createRecord("root-alias", { cwd: alias });
        const bound = yield* f.createRecord("file-only");
        f.bindings.set(ThreadId.make("old-thread"), {
          threadId: ThreadId.make("old-thread"),
          provider: ProviderDriverKind.make("pi"),
          status: "stopped",
          resumeCursor: { piSessionFile: `${alias}/file-only.jsonl` },
          lastSeenAt: timestamp,
        });
        f.setRecords([
          good,
          bound,
          { ...good, sessionId: "missing", sessionFile: `${f.root}/missing.jsonl` },
        ]);
        expect((yield* f.sync.refresh).importedCount).toBe(1);
        expect(f.commands).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "recovers its own incomplete stopped import without replacing an ordinary binding",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const record = yield* f.createRecord("partial");
        const threadId = ThreadId.make("import:pi:partial");
        f.bindings.set(threadId, {
          threadId,
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          status: "stopped",
          resumeCursor: { piSessionId: record.sessionId, piSessionFile: record.sessionFile },
          lastSeenAt: timestamp,
        });
        f.setRecords([record]);
        expect((yield* f.sync.refresh).importedCount).toBe(1);
        expect(f.bindings.size).toBe(1);
        expect((yield* f.sync.refresh).importedCount).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "imports eligible live and stopped history with a file cursor and does not duplicate bindings",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const good = yield* f.createRecord("good");
        const alias = `${f.root}/alias.jsonl`;
        yield* f.fs.symlink(good.sessionFile!, alias);
        f.setRecords([
          good,
          { ...good, sessionId: "alias", sessionFile: alias },
          yield* f.createRecord("live", { live: true }),
          yield* f.createRecord("owned", { owner: "t3" }),
          yield* f.createRecord("linked", { t3: { thread: "other" } }),
          yield* f.createRecord("unknown", { agentDir: "/unknown" }),
          yield* f.createRecord("nested", { cwd: `${f.root}/agent` }),
          yield* f.createRecord("bound"),
        ]);
        f.bindings.set(ThreadId.make("pre-existing"), {
          threadId: ThreadId.make("pre-existing"),
          provider: ProviderDriverKind.make("pi"),
          status: "stopped",
          resumeCursor: { piSessionId: "bound" },
          lastSeenAt: timestamp,
        });
        expect(yield* f.sync.refresh).toEqual({ importedCount: 2, skippedCount: 0 });
        expect(f.bindings.get(ThreadId.make("import:pi:good"))?.resumeCursor).toEqual({
          piSessionId: "good",
          piSessionFile: good.sessionFile,
        });
        expect(f.commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.history.import",
          "thread.create",
          "thread.history.import",
        ]);
        expect(f.links.map((link) => link.sessionId)).toEqual(["good", "live"]);
        expect(yield* f.sync.refresh).toEqual({ importedCount: 0, skippedCount: 0 });
        expect(f.commands).toHaveLength(4);
      }).pipe(Effect.scoped),
  );

  it.effect("is optional, retries a later daemon, and serializes overlapping refreshes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.sync.refresh).toEqual({ importedCount: 0, skippedCount: 0 });
      yield* Queue.take(f.requests);
      f.setRecords([yield* f.createRecord("later")]);
      const gate = yield* Deferred.make<void>();
      f.setGate(Deferred.await(gate));
      const first = yield* f.sync.refresh.pipe(Effect.forkScoped);
      yield* Queue.take(f.requests);
      const second = yield* f.sync.refresh.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(first)).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* Fiber.join(second)).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(f.calls()).toBe(3);
      yield* f.sync.drain;
    }).pipe(Effect.scoped),
  );

  it.effect("drains bounded batches without waiting for another push", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const records = yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => String(index)),
        (id) => f.createRecord(id),
      );
      f.setRecords(records);
      expect((yield* f.sync.refresh).importedCount).toBe(101);
      expect((yield* f.sync.refresh).importedCount).toBe(0);
      expect(f.commands).toHaveLength(202);
    }).pipe(Effect.scoped),
  );

  it.effect("parks startup, then imports pushed lists without polling", () =>
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const f = yield* fixture();
      yield* f.sync
        .start()
        .pipe(Effect.provideService(ServerActivation, Deferred.await(activation)));
      expect(f.calls()).toBe(0);
      yield* Deferred.succeed(activation, undefined);
      yield* Queue.take(f.requests);
      yield* f.sync.drain;
      yield* PubSub.publish(f.pushed, [yield* f.createRecord("pushed")]);
      // Barrier: wait for the worker's import rather than a wall-clock sleep.
      yield* Effect.yieldNow;
      yield* f.sync.drain;
      expect(f.links.map((link) => link.sessionId)).toEqual(["pushed"]);
      yield* TestClock.adjust("5 minutes");
      expect(f.calls()).toBe(0);
    }).pipe(Effect.scoped),
  );
});
