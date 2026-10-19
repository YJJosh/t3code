import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2AppThreadJson,
  ThreadId,
  ProviderSessionId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as EventSink from "../EventSink.ts";
import * as Importer from "./LegacyV1ThreadImporter.ts";
import * as DulliSubagents from "../../provider/dulli/DulliSubagents.ts";
import { makeSubagentFactory } from "../../provider/dulli/DulliSubagentBridge.ts";
import {
  importDulliLegacySubagentHistory,
  makeDulliLegacyTaskProjector,
} from "./DulliLegacySubagentHistory.ts";

const database = Sqlite.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const layer = Importer.layer.pipe(
  Layer.provideMerge(sink),
  Layer.merge(IdAllocator.layer),
  Layer.merge(DulliSubagents.layer),
);
const threadId = ThreadId.make("legacy/parent");
const at = (second: number) =>
  `2026-01-01T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const payload = (extra: Record<string, unknown> = {}) => ({
  taskId: "child/1",
  taskType: "pi-subagent",
  agentKind: "agent",
  title: "Reader",
  model: "anthropic/claude",
  runHandles: { runId: "child/1" },
  ...extra,
});
const transcript = (sequence: number, text: string) => ({
  managerId: "native-manager",
  sequence,
  timestamp: at(sequence),
  kind: "child_message",
  activity: {
    type: "message_end",
    data: { message: { role: "assistant", content: [{ type: "text", text }] } },
  },
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','P','/tmp','[]',${at(0)},${at(0)})`;
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES(${threadId},'p','Legacy','{"instanceId":"dulli","model":"default"}',${at(0)},${at(30)})`;
  const importer = yield* Importer.LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  const rows = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
  return yield* decodeThread(rows[0]!.payload_json);
});
const add = (id: string, kind: string, second: number, value: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_activities(activity_id,thread_id,tone,kind,summary,payload_json,created_at) VALUES(${id},${threadId},'info',${kind},'Task',${encode(value)},${at(second)})`;
  });

describe("Dulli legacy child history", () => {
  it.effect(
    "repairs already hydrated threads, preserves terminal states/workflows/usage and does not duplicate on retry",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const importer = yield* Importer.LegacyV1ThreadImporter;
        yield* importer.ensureTranscript(threadId);
        yield* sql`INSERT INTO dulli_fork_migrations VALUES('fork-detected')`;
        const linkage = {
          parentAgentId: "workflow",
          workflowName: "Review",
          phaseTitle: "Inspect",
        };
        yield* add("start", "task.started", 1, payload({ ...linkage, detail: "Read the source" }));
        yield* add(
          "text",
          "task.progress",
          2,
          payload({ ...linkage, transcriptEvent: transcript(2, "\u001b[31mFindings\u001b[0m") }),
        );
        yield* add(
          "done",
          "task.completed",
          3,
          payload({
            ...linkage,
            status: "failed",
            summary: "Cannot proceed",
            typedUsage: { totalTokens: 70, inputTokens: 50, outputTokens: 20 },
          }),
        );
        yield* add("late", "task.updated", 4, payload({ ...linkage, status: "running" }));
        yield* add(
          "stopped",
          "task.completed",
          5,
          payload({ taskId: "stopped", status: "stopped" }),
        );
        yield* add("orphan", "task.started", 6, payload({ taskId: "orphan" }));
        yield* add(
          "codex",
          "task.completed",
          7,
          payload({ taskId: "codex", taskType: "codex-subagent" }),
        );
        const result = yield* importDulliLegacySubagentHistory();
        assert.equal(result.runs, 4);
        assert.equal(result.transcriptItems, 1);
        assert.equal(result.skippedRows, 1);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const records = yield* projections.getThreadRecords(threadId, [
          "subagents",
          "turnItems",
          "nodes",
        ]);
        const child = records.subagents.find(
          (agent) => agent.nativeTaskRef?.nativeId === "child/1",
        )!;
        assert.equal(child.id, "dulli:subagent:legacy%2Fparent:child%2F1");
        assert.equal(child.status, "failed");
        assert.equal(child.result, "Cannot proceed");
        assert.equal(child.prompt, "Read the source");
        assert.equal(child.usage?.totalTokens, 70);
        assert.equal(DateTime.formatIso(child.completedAt!), at(3));
        assert.equal(
          records.subagents.find((agent) => agent.nativeTaskRef?.nativeId === "workflow")?.workflow
            ?.agents[0]?.state,
          "failed",
        );
        for (const id of ["stopped", "orphan"])
          assert.equal(
            records.subagents.find((agent) => agent.nativeTaskRef?.nativeId === id)?.status,
            "interrupted",
          );
        const text = records.turnItems.find((item) => item.type === "assistant_message");
        assert.equal(text?.type === "assistant_message" ? text.text : null, "Findings");
        assert.equal(text?.nativeItemRef?.nativeId, "native-manager:2:assistant_message:");
        assert.equal(text?.nativeItemRef?.fingerprint, "native-manager:message:2:text");
        const before = yield* sql`SELECT event_id FROM orchestration_events`;
        assert.deepStrictEqual(yield* importDulliLegacySubagentHistory(), {
          runs: 0,
          transcriptItems: 0,
          acceptedRows: 0,
          skippedRows: 0,
        });
        yield* importer.importPendingTranscripts;
        assert.deepStrictEqual(yield* sql`SELECT event_id FROM orchestration_events`, before);

        const existingProjector = yield* makeDulliLegacyTaskProjector(
          yield* seedThread,
          records.subagents,
        );
        yield* existingProjector.accept({
          activity_id: "old-start",
          kind: "task.started",
          created_at: at(1),
          payload_json: encode(payload()),
        });
        const ignored = yield* existingProjector.finish;
        assert.equal(ignored.skippedRows, 1);
        assert.lengthOf(ignored.events, 0);

        // Reconnect to the actual live bridge with imported records: historical replay
        // cannot reopen the child or append a second transcript slot.
        const agents = new Map<string, OrchestrationV2Subagent>(
          records.subagents.map((agent) => [agent.id, agent]),
        );
        const items = new Map<string, OrchestrationV2TurnItem>(
          records.turnItems.map((item) => [item.id, item]),
        );
        const thread = yield* seedThread;
        const controls = yield* DulliSubagents.DulliSubagents;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const bridge = yield* makeSubagentFactory({
          controls,
          read: () => Effect.succeed(records),
        })({
          threadId,
          providerSessionId: ProviderSessionId.make("live"),
          instanceId: thread.providerInstanceId,
          settings: {
            enabled: true,
            binaryPath: "pi",
            profile: "coder",
            agentDir: "",
            piSessions: false,
            shareWithTerminal: false,
            customModels: [],
          },
          environment: {},
          cwd: "/tmp",
          modelSelection: thread.modelSelection,
          ids,
          getProviderThread: () => null,
          getActiveTurn: () => null,
          rpc: { send: () => Effect.void, request: () => Effect.void },
          emit: (event) =>
            Effect.sync(() => {
              if (event.type === "subagent.updated") agents.set(event.subagent.id, event.subagent);
              if (event.type === "turn_item.updated") items.set(event.turnItem.id, event.turnItem);
            }),
        });
        yield* bridge.notify![0]!.handle(
          encode({
            contractVersion: 1,
            managerId: "native-manager",
            sequence: 10,
            timestamp: at(10),
            kind: "run_running",
            runId: "child/1",
            replay: true,
            view: { runId: "child/1", state: "running" },
          }),
          {},
        );
        yield* bridge.notify![0]!.handle(
          encode({
            ...transcript(2, "Findings"),
            contractVersion: 1,
            runId: "child/1",
            replay: true,
          }),
          {},
        );
        assert.equal(agents.size, records.subagents.length);
        assert.equal(agents.get(child.id)?.status, "failed");
        assert.equal(items.size, records.turnItems.length);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("uses the live transcript size cap and skips malformed/non-Pi rows", () =>
    Effect.gen(function* () {
      const thread = yield* seed;
      const projector = yield* makeDulliLegacyTaskProjector(thread);
      const accept = (id: number, value: unknown) =>
        projector.accept({
          activity_id: String(id),
          kind: "task.progress",
          created_at: at(id),
          payload_json: encode(value),
        });
      yield* accept(
        1,
        payload({ transcriptEvent: transcript(1, "x".repeat(2 * 1024 * 1024 + 100)) }),
      );
      yield* accept(2, payload({ transcriptEvent: transcript(2, "newer") }));
      yield* accept(3, { taskId: "shell", taskType: "shell" });
      yield* projector.accept({
        activity_id: "bad",
        kind: "task.started",
        created_at: at(1),
        payload_json: "{",
      });
      const result = yield* projector.finish;
      const items = result.events.flatMap((event) =>
        event.type === "turn-item.updated" && event.payload.type === "assistant_message"
          ? [event.payload]
          : [],
      );
      assert.isAtMost(
        items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
        2 * 1024 * 1024,
      );
      assert.equal(result.skippedRows, 2);
      assert.equal(result.runs, 1);
      assert.equal(items.at(-1)?.text, "newer");
      assert.isTrue(items.every((item) => !item.streaming && item.status !== "running"));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("retains at most 1,000 slots per run and deduplicates native sequence replay", () =>
    Effect.gen(function* () {
      const thread = yield* seed;
      const projector = yield* makeDulliLegacyTaskProjector(thread);
      for (let sequence = 1; sequence <= 1005; sequence++) {
        yield* projector.accept({
          activity_id: String(sequence),
          kind: "task.progress",
          created_at: at(sequence),
          payload_json: encode(
            payload({ transcriptEvent: transcript(sequence, `entry-${sequence}`) }),
          ),
        });
      }
      yield* projector.accept({
        activity_id: "duplicate",
        kind: "task.progress",
        created_at: at(1005),
        payload_json: encode(payload({ transcriptEvent: transcript(1005, "entry-1005") })),
      });
      const result = yield* projector.finish;
      const items = result.events.flatMap((event) =>
        event.type === "turn-item.updated" && event.payload.type === "assistant_message"
          ? [event.payload]
          : [],
      );
      assert.equal(items.length, 1000);
      assert.equal(new Set(items.map((item) => item.nativeItemRef?.nativeId)).size, 1000);
      assert.isTrue(items.some((item) => item.text === "entry-1005"));
      assert.isFalse(items.some((item) => item.text === "entry-1"));
      assert.isTrue(items.every((item) => !item.streaming));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect(
    "hydrates on first open, but never adopts task records on a clean upstream installation",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* add("done", "task.completed", 1, payload({ status: "completed" }));
        assert.equal((yield* importDulliLegacySubagentHistory()).runs, 0);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO dulli_fork_migrations VALUES('fork-detected')`;
        const importer = yield* Importer.LegacyV1ThreadImporter;
        yield* importer.ensureTranscript(threadId);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.equal(
          (yield* projections.getThreadRecords(threadId, ["subagents"])).subagents.length,
          1,
        );
      }).pipe(Effect.provide(layer)),
  );
});
const seedThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
  return yield* decodeThread(rows[0]!.payload_json);
});
