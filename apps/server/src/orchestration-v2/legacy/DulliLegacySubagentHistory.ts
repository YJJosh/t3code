import {
  EventId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2SubagentJson,
  ProviderSessionId,
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { makeSubagentFactory } from "../../provider/dulli/DulliSubagentBridge.ts";
import * as DulliSubagents from "../../provider/dulli/DulliSubagents.ts";
import * as EventSink from "../EventSink.ts";

export interface DulliLegacyTaskRow {
  readonly activity_id: string;
  readonly kind: string;
  readonly created_at: string;
  readonly payload_json: string;
  readonly sequence?: number | null;
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const marker = (threadId: string) => `subagent-history-v1:${threadId}`;
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeAgent = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2SubagentJson));

/** Feed legacy envelopes through the live projector: native IDs, tool/message
 * deduplication, sanitization and the 1,000 item / 2 MiB per-run ring stay identical.
 * No RPC or session lifecycle is started. Only the final bounded records are saved,
 * not thousands of historical intermediate states in the v2 event log. */
export const makeDulliLegacyTaskProjector = Effect.fn(function* (
  thread: OrchestrationV2AppThread,
  existing: ReadonlyArray<OrchestrationV2Subagent> = [],
) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const controls = yield* DulliSubagents.DulliSubagents;
  const events = new Map<string, OrchestrationV2DomainEvent>();
  const agents = new Map<string, OrchestrationV2Subagent>();
  const dulli = existing.filter((agent) => agent.driver === "dulli");
  const existingIds = new Set<string>(dulli.map((agent) => agent.id));
  const existingRuns = new Set(dulli.map((agent) => agent.nativeTaskRef?.nativeId));
  let skippedRows = 0;
  let acceptedRows = 0;
  // REVIEW: synthetic run events reuse the run's native manager id. The bridge's
  // terminal flush keys the pending reply by manager; "legacy" projected it twice.
  const managerIds = new Map<string, string>();
  const bridge = yield* makeSubagentFactory({
    controls,
    read: () => Effect.succeed({ subagents: existing, turnItems: [] }),
  })({
    threadId: thread.id,
    providerSessionId: ProviderSessionId.make(`migration:dulli:${thread.id}`),
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
    cwd: "",
    modelSelection: thread.modelSelection,
    ids,
    getProviderThread: () => null,
    getActiveTurn: () => null,
    rpc: { send: () => Effect.void, request: () => Effect.void },
    emit: (event) =>
      Effect.sync(() => {
        const payload =
          event.type === "subagent.updated"
            ? event.subagent
            : event.type === "node.updated"
              ? event.node
              : event.type === "turn_item.updated"
                ? event.turnItem
                : undefined;
        if (
          !payload ||
          existingIds.has(payload.id) ||
          ("nodeId" in payload && payload.nodeId && existingIds.has(payload.nodeId))
        )
          return;
        const type = event.type === "turn_item.updated" ? "turn-item.updated" : event.type;
        const id = EventId.make(`migration:dulli:history:${type}:${payload.id}`);
        const occurredAt =
          "updatedAt" in payload
            ? payload.updatedAt
            : (payload.completedAt ?? payload.startedAt ?? thread.updatedAt);
        // Narrowing each payload separately keeps the domain event union correlated.
        if (event.type === "subagent.updated") {
          agents.set(event.subagent.nativeTaskRef!.nativeId!, event.subagent);
          events.set(id, {
            id,
            type: "subagent.updated",
            threadId: thread.id,
            occurredAt,
            payload: event.subagent,
          });
        } else if (event.type === "node.updated") {
          events.set(id, {
            id,
            type: "node.updated",
            threadId: thread.id,
            occurredAt,
            payload: event.node,
          });
        } else if (event.type === "turn_item.updated") {
          events.set(id, {
            id,
            type: "turn-item.updated",
            threadId: thread.id,
            occurredAt,
            payload: event.turnItem,
          });
        }
      }),
  });
  const notify = (value: unknown) => bridge.notify![0]!.handle(encodeJson(value), {});
  const accept = (row: DulliLegacyTaskRow) =>
    Effect.gen(function* () {
      if (row.payload_json.length > 8 * 1024 * 1024) {
        skippedRows++;
        return;
      }
      const decoded = decodeJson(row.payload_json);
      if (Option.isNone(decoded)) {
        skippedRows++;
        return;
      }
      const payload = record(decoded.value);
      const runId = string(payload.taskId);
      // The fork's generic inspector also displayed Codex/Claude agents. Those are
      // not Pi runs; importing them with Dulli identities would route controls wrong.
      if (
        (payload.taskType !== "pi-subagent" && !(runId && agents.has(runId))) ||
        !runId ||
        existingRuns.has(runId) ||
        !Number.isFinite(Date.parse(row.created_at))
      ) {
        skippedRows++;
        return;
      }
      acceptedRows++;
      const old = agents.get(runId);
      const status = string(payload.status);
      const ended = row.kind === "task.completed" || (status !== undefined && terminal(status));
      const state =
        old && terminal(old.status)
          ? old.status === "completed"
            ? "done"
            : old.status === "cancelled"
              ? "interrupted"
              : old.status
          : status === "failed"
            ? "failed"
            : status === "stopped" || status === "cancelled" || status === "interrupted"
              ? "interrupted"
              : ended
                ? "done"
                : status === "waiting"
                  ? "needs_input"
                  : "running";
      const usage = record(payload.typedUsage);
      const parent = string(payload.parentAgentId);
      const at =
        ended && string(payload.endedAt) && Number.isFinite(Date.parse(String(payload.endedAt)))
          ? String(payload.endedAt)
          : row.created_at;
      const transcript = record(payload.transcriptEvent);
      const transcriptManager = transcript.activity ? string(transcript.managerId) : undefined;
      if (transcriptManager) managerIds.set(runId, transcriptManager);
      // Transcript rows repeat the same (sometimes multi-KiB) run metadata.
      // Project it only when discovering the run, not once per tool output.
      if (!old || !transcript.activity)
        yield* notify({
          contractVersion: 1,
          managerId: managerIds.get(runId) ?? "legacy",
          sequence: acceptedRows,
          timestamp: at,
          runId,
          kind:
            state === "interrupted"
              ? "interrupted"
              : ended || (old && terminal(old.status))
                ? "terminal"
                : "run_running",
          view: {
            runId,
            state,
            task: old?.prompt || string(payload.detail) || string(payload.title) || runId,
            model: payload.model,
            effort: payload.effort,
            progressNote:
              row.kind === "task.progress" ? (payload.summary ?? payload.detail) : undefined,
            result: ended
              ? {
                  result: {
                    summary: old?.result ?? payload.summary ?? payload.error ?? payload.detail,
                  },
                }
              : undefined,
            ...(parent
              ? {
                  workflow: {
                    runId: parent,
                    name: payload.workflowName,
                    phase: payload.phaseTitle,
                    label: payload.title,
                  },
                }
              : {}),
            ...(usage.totalTokens !== undefined
              ? {
                  usageSoFar: {
                    total: usage.totalTokens,
                    input: usage.inputTokens,
                    output: usage.outputTokens,
                    cacheRead: usage.cachedInputTokens,
                    turns: usage.toolUses,
                  },
                  activeMs: usage.durationMs,
                }
              : {}),
          },
        });
      if (transcript.activity)
        yield* notify({
          ...transcript,
          contractVersion: 1,
          runId,
          replay: true,
          timestamp:
            typeof transcript.timestamp === "string" &&
            Number.isFinite(Date.parse(transcript.timestamp))
              ? transcript.timestamp
              : row.created_at,
        });
    });
  const finish = Effect.gen(function* () {
    // No process survived the v1 cutover. Incomplete histories must not show live
    // controls forever. Do not use wall-clock time: replay freshness is native time.
    for (const [runId, agent] of agents) {
      if (terminal(agent.status)) continue;
      yield* notify({
        contractVersion: 1,
        managerId: managerIds.get(runId) ?? "legacy",
        sequence: acceptedRows + 1,
        timestamp: DateTime.formatIso(agent.updatedAt),
        runId,
        kind: "interrupted",
        view: { runId, state: "interrupted" },
      });
    }
    return { events: [...events.values()], acceptedRows, skippedRows, runs: agents.size };
  });
  return { accept, finish };
});

/** Also repairs threads whose ordinary transcript was imported by older builds.
 * Invoked on demand or by background hydration, never by shell reconciliation. */
export const importDulliLegacySubagentHistory = (threadId?: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    if (!(yield* sql`SELECT 1 FROM dulli_fork_migrations WHERE name = 'fork-detected'`).length)
      return { runs: 0, transcriptItems: 0, acceptedRows: 0, skippedRows: 0 };
    const threads = yield* sql<{ thread_id: string; payload_json: string; instance_id: string }>`
    SELECT t.thread_id, t.payload_json,
      coalesce((SELECT provider_instance_id FROM provider_session_runtime r
        WHERE r.thread_id = t.thread_id AND r.provider_name = 'dulli'),
        (SELECT provider_instance_id FROM dulli_fork_native_threads n WHERE n.thread_id = t.thread_id),
        'dulli') AS instance_id
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_legacy_imports i ON i.thread_id = t.thread_id
    WHERE (${threadId ?? null} IS NULL OR t.thread_id = ${threadId ?? null})
      AND NOT EXISTS (SELECT 1 FROM dulli_fork_migrations m
        WHERE m.name = 'subagent-history-v1:' || t.thread_id)
  `;
    const totals = { runs: 0, transcriptItems: 0, acceptedRows: 0, skippedRows: 0 };
    for (const row of threads) {
      const stored = yield* sql<{ payload_json: string }>`SELECT payload_json
        FROM orchestration_v2_projection_subagents WHERE thread_id = ${row.thread_id}`;
      const current = yield* decodeThread(row.payload_json);
      const instanceId = ProviderInstanceId.make(row.instance_id);
      const thread = {
        ...current,
        providerInstanceId: instanceId,
        modelSelection: { ...current.modelSelection, instanceId },
      };
      const existing = yield* Effect.forEach(stored, (entry) => decodeAgent(entry.payload_json));
      const projector = yield* makeDulliLegacyTaskProjector(thread, existing);
      let cursor: DulliLegacyTaskRow | undefined;
      while (true) {
        const rows = yield* sql<DulliLegacyTaskRow>`
          SELECT activity_id, kind, created_at, payload_json, sequence
          FROM projection_thread_activities WHERE thread_id = ${row.thread_id}
            AND kind IN ('task.started', 'task.progress', 'task.updated', 'task.completed')
            AND (created_at, coalesce(sequence, -1), activity_id) >
              (${cursor?.created_at ?? ""}, ${cursor?.sequence ?? -1}, ${cursor?.activity_id ?? ""})
          ORDER BY created_at, coalesce(sequence, -1), activity_id LIMIT 100`;
        for (const activity of rows) yield* projector.accept(activity);
        if (rows.length < 100) break;
        cursor = rows.at(-1);
        yield* Effect.yieldNow;
      }
      const result = yield* projector.finish;
      // Legacy activities are immutable after cutover. Fold them outside the write
      // transaction so reading old tool output cannot hold up live command commits.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            (yield* sql`SELECT 1 FROM dulli_fork_migrations WHERE name = ${marker(row.thread_id)}`)
              .length
          )
            return;
          // A live replay or first-open import may have won while the background
          // fold yielded. Never replace its newer state (or import the run twice).
          const live = yield* sql<{ subagent_id: string }>`SELECT subagent_id
          FROM orchestration_v2_projection_subagents WHERE thread_id = ${row.thread_id}`;
          const liveIds = new Set<string>(live.map((agent) => agent.subagent_id));
          const events = result.events.filter(
            (event) =>
              !(
                "id" in event.payload &&
                typeof event.payload.id === "string" &&
                liveIds.has(event.payload.id)
              ) &&
              !(
                "nodeId" in event.payload &&
                event.payload.nodeId &&
                liveIds.has(event.payload.nodeId)
              ),
          );
          for (let index = 0; index < events.length; index += 100) {
            yield* sink.write({ events: events.slice(index, index + 100) });
          }
          yield* sql`INSERT OR IGNORE INTO dulli_fork_migrations(name) VALUES (${marker(row.thread_id)})`;
          totals.runs += events.filter((event) => event.type === "subagent.updated").length;
          totals.acceptedRows += result.acceptedRows;
          totals.skippedRows += result.skippedRows;
          totals.transcriptItems += events.filter(
            (event) =>
              event.type === "turn-item.updated" && event.payload.id.includes(":transcript:"),
          ).length;
        }),
      );
      yield* Effect.yieldNow;
    }
    return totals;
  }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, DulliSubagents.layer)), Effect.scoped);
