import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { PiSessionsClient, type PiSessionInfo } from "@t3tools/provider-dulli/server";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as PiSessionsSettlement from "../persistence/PiSessionsSettlement.ts";
import migration from "../persistence/Migrations/065_PiSessionsSettlement.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as PiSessionTranscript from "./PiSessionTranscript.ts";
import * as PiSessionsSync from "./PiSessionsSync.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("import:pi:native");
const instanceId = ProviderInstanceId.make("dulli");
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* fs.makeTempDirectoryScoped();
  const cwd = yield* fs.realPath(root);
  const agentDir = `${cwd}/agent`;
  yield* fs.makeDirectory(agentDir);
  const sessionFile = `${cwd}/native.jsonl`;
  yield* fs.writeFileString(
    sessionFile,
    [
      { type: "session", version: 3, id: "native", cwd, timestamp: "2026-08-24T10:00:00.000Z" },
      {
        type: "message",
        id: "u",
        parentId: null,
        timestamp: "2026-08-24T10:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
    ]
      .map((record) => encode(record))
      .join("\n"),
  );
  yield* migration;
  yield* sql`DELETE FROM pi_sessions_settlement`;
  yield* sql`DROP TABLE IF EXISTS dulli_fork_migrations`;
  yield* sql`DROP TABLE IF EXISTS orchestration_v2_projection_threads`;
  yield* sql`DROP TABLE IF EXISTS orchestration_v2_projection_provider_threads`;
  yield* sql`CREATE TABLE dulli_fork_migrations (name TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, payload_json TEXT)`;
  const now = yield* DateTime.now;
  let shell: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project"),
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "provider/model" },
    title: "terminal",
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "system",
    creationSource: "server",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: ProviderThreadId.make("binding"),
    historyOrigin: "v1_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: now,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const binding: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("binding"),
    driver: ProviderDriverKind.make("dulli"),
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("dulli"),
      nativeId: sessionFile,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  let record: PiSessionInfo = {
    sessionId: "native",
    sessionFile,
    cwd,
    agentDir,
    status: "done",
    owner: "daemon",
    createdAt: 1,
    updatedAt: 2,
    live: false,
    attached: 0,
    settleRev: 1,
  };
  let sequence = 1;
  let race = false;
  let daemonConflict = false;
  const mutations: Array<{ settled: boolean; ifRev: number }> = [];
  const opens: Array<
    Parameters<ProviderSessionManager.ProviderSessionManagerV2["Service"]["open"]>[0]
  > = [];
  let live = false;
  const links: string[] = [];
  const imports: Array<AgentSessionScanner.AgentSessionRecentThread> = [];
  const register = Effect.gen(function* () {
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId}, ${encode(shell)})`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES (${binding.id}, ${threadId}, 'dulli', ${encode(binding)})`;
  });
  let providerInstances: Record<string, ProviderInstanceConfig> = {
    dulli: {
      driver: ProviderDriverKind.make("dulli"),
      enabled: true,
      config: { agentDir },
    },
  };
  const layer = PiSessionsSync.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        PiSessionTranscript.layer,
        PiSessionsSettlement.layer,
        // REVIEW: Default-instance discovery must use only this sandbox home in tests.
        Layer.succeed(HostProcess.Environment, { PI_CODING_AGENT_DIR: agentDir }),
        IdAllocator.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances,
          })),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([{ id: shell.projectId, workspaceRoot: cwd } as never]),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.sync(() => shell),
        }),
        Layer.mock(EventSink.EventSinkV2)({ latestSequence: () => Effect.sync(() => sequence) }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.sync(() => live),
          open: (input) =>
            Effect.sync(() => {
              opens.push(input);
              live = true;
              return { resumeThread: () => Effect.succeed(binding) } as never;
            }),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({ runtimeMode: "full-access", interactionMode: "default", cwd }),
        }),
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          importPreparedAgentThreads: (_, prepared) =>
            Effect.sync(() => {
              imports.push(...prepared);
              return { importedCount: 1, skippedCount: 0 };
            }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.gen(function* () {
              if (
                command.type === "thread.settle" ||
                command.type === "thread.unsettle" ||
                command.type === "thread.metadata.update"
              ) {
                if (command.expectedSequence !== sequence)
                  return yield* new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "changed",
                  });
                if (command.type === "thread.metadata.update")
                  shell = { ...shell, branch: command.branch ?? null };
                else
                  shell = {
                    ...shell,
                    settledOverride: command.type === "thread.settle" ? "settled" : "active",
                  };
                sequence++;
              }
              return { sequence, storedEvents: [] };
            }),
        }),
        Layer.succeed(PiSessionsClient.PiSessionsClient, {
          list: Effect.sync(() => [record]),
          watch: () => Effect.never,
          link: (input) =>
            Effect.sync(() => {
              links.push(input.t3.thread);
            }),
          settle: (input) =>
            Effect.sync(() => {
              mutations.push(input);
              if (race) {
                sequence++;
                shell = { ...shell, title: "changed during CAS" };
              }
              if (daemonConflict || input.ifRev !== record.settleRev) return null;
              const changed = (record.settledAt !== undefined) !== input.settled;
              record = {
                ...record,
                settleRev: input.ifRev + Number(changed),
                ...(input.settled ? { settledAt: 2 } : {}),
              };
              if (!input.settled) {
                const { settledAt: _, ...rest } = record;
                record = rest;
              }
              return record;
            }),
        }),
      ),
    ),
  );
  const service = Context.get(yield* Layer.build(layer), PiSessionsSync.PiSessionsSync);
  const store = yield* PiSessionsSettlement.PiSessionsSettlement.pipe(
    Effect.provide(PiSessionsSettlement.layer),
  );
  const link = { environmentId: EnvironmentId.make("env"), threadId, sessionId: "native" };
  return {
    service,
    setInstances: (instances: Record<string, ProviderInstanceConfig>) => {
      providerInstances = instances;
    },
    opens,
    store,
    link,
    register,
    imports,
    links,
    mutations,
    cwd,
    fs,
    shell: () => shell,
    record: () => record,
    updateShell: (patch: Partial<OrchestrationV2AppThread>) => {
      shell = { ...shell, ...patch };
    },
    updateRecord: (patch: Partial<PiSessionInfo>) => {
      record = { ...record, ...patch };
    },
    unsettleDaemon: () => {
      const { settledAt: _, ...rest } = record;
      record = rest;
    },
    race: () => {
      race = true;
    },
    conflict: () => {
      daemonConflict = true;
    },
  };
});
const layer = Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" }));
it.layer(layer)("PiSessionsSync", (it) => {
  // REVIEW: A fresh/reset default instance shares terminal chats without an explicit slot.
  it.effect("imports with an unconfigured default, but respects a disabled or occupied slot", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setInstances({
        dulli: { driver: ProviderDriverKind.make("dulli"), enabled: false, config: {} },
      });
      yield* f.service.refresh;
      expect(f.imports).toHaveLength(0);
      f.setInstances({ dulli: { driver: ProviderDriverKind.make("pi"), config: {} } });
      yield* f.service.refresh;
      expect(f.imports).toHaveLength(0);
      f.setInstances({});
      yield* f.service.refresh;
      expect(f.imports).toHaveLength(1);
      expect(f.imports[0]).toMatchObject({
        _tag: "Importable",
        thread: { source: "dulli", providerSessionId: "native" },
      });
    }).pipe(Effect.scoped),
  );
  it.effect("relinks migrated import:pi IDs without duplicating imported conversations", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.register;
      yield* f.service.refresh;
      expect(f.imports).toHaveLength(0);
      expect(f.links).toEqual([threadId]);
      expect(f.shell().settledOverride).toBe("active");
      expect(Option.getOrThrow(yield* f.store.get(f.link))).toEqual({
        daemonRev: 1,
        daemonSettled: false,
        t3Settled: false,
      });
    }).pipe(Effect.scoped),
  );
  it.effect("does not acknowledge a T3 concurrent edit or a daemon CAS conflict", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.register;
      f.race();
      yield* f.service.refresh;
      expect(f.shell().settledOverride).toBe("settled");
      expect(Option.isNone(yield* f.store.get(f.link))).toBe(true);
      f.conflict();
      yield* f.service.refresh;
      expect(Option.isNone(yield* f.store.get(f.link))).toBe(true);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "outgoing settlement uses daemon revision and durable baseline detects later terminal changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.register;
        yield* f.store.set(f.link, { daemonRev: 1, daemonSettled: false, t3Settled: false });
        yield* f.service.refresh;
        expect(f.mutations).toMatchObject([{ settled: true, ifRev: 1 }]);
        expect(f.record().settleRev).toBe(2);
        f.updateRecord({ settleRev: 3 });
        f.unsettleDaemon();
        yield* f.service.refresh;
        expect(f.shell().settledOverride).toBe("active");
      }).pipe(Effect.scoped),
  );
  it.effect("attaches a live linked daemon session once and never requests a new writer", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.register;
      f.updateRecord({ live: true, t3: { thread: threadId, environment: "env" } });
      yield* f.service.refresh;
      yield* f.service.refresh;
      expect(f.opens).toHaveLength(1);
      expect(f.opens[0]).toMatchObject({
        threadId,
        attachOnly: true,
        initialNativeThreadId: `${f.cwd}/native.jsonl`,
      });
    }).pipe(Effect.scoped),
  );
  it.effect("skips archived and foreign-environment links", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.register;
      f.updateShell({ archivedAt: yield* DateTime.now });
      yield* f.service.refresh;
      f.updateShell({ archivedAt: null });
      f.updateRecord({ t3: { thread: threadId, environment: "other" } });
      yield* f.service.refresh;
      expect(f.mutations).toHaveLength(0);
      expect(f.links).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
  it.effect("imports only into a matching existing project and validates Workler branch HEAD", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.service.refresh;
      expect(f.imports[0]).toMatchObject({
        _tag: "Importable",
        thread: { source: "dulli", providerSessionId: "native" },
      });
      const worktree = `${f.cwd}/.worktrees/topic`;
      yield* f.fs.makeDirectory(`${worktree}/.git`, { recursive: true });
      yield* f.fs.writeFileString(`${worktree}/.git/HEAD`, "ref: refs/heads/actual\n");
      f.updateRecord({
        cwd: worktree,
        branch: "stale",
        t3: { thread: threadId, environment: "env" },
      });
      f.updateShell({ worktreePath: worktree, branch: "before" });
      yield* f.register;
      yield* f.service.refresh;
      expect(f.shell().branch).toBe("before");
      f.updateRecord({ branch: "actual" });
      yield* f.service.refresh;
      expect(f.shell().branch).toBe("actual");
    }).pipe(Effect.scoped),
  );
});
