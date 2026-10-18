import { findDulliSessionFile } from "./DulliSessionFile.ts";
import {
  EventId,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../EventSink.ts";

const decodeThread = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));

/** Runs after shell import, including shells imported by an earlier upstream build.
 * Migration 64 freezes the eligible cursors; this pass never adopts future upstream Pi
 * threads or reattaches a cursor after a user subsequently switches providers.
 */
export const restoreDulliNativeContinuity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const rows = yield* sql<{
    thread_id: string;
    provider_instance_id: string;
    session_file: string;
  }>`
    SELECT legacy.thread_id, legacy.provider_instance_id, legacy.session_file
    FROM dulli_fork_native_threads AS legacy
    INNER JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = legacy.thread_id
    WHERE legacy.imported = 0
  `;
  for (const row of rows) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // UUID recovery can perform filesystem I/O after startup. Re-read under
        // the write transaction rather than trusting the earlier shell snapshot.
        const current = yield* sql<{ payload_json: string }>`
          SELECT thread.payload_json FROM orchestration_v2_projection_threads thread
          JOIN dulli_fork_native_threads legacy ON legacy.thread_id = thread.thread_id
          WHERE thread.thread_id = ${row.thread_id} AND legacy.imported = 0
        `;
        if (current[0] === undefined) return;
        const thread = yield* decodeThread(current[0].payload_json);
        // Never displace an existing v2 binding or a selection the user already changed.
        if (
          thread.activeProviderThreadId === null &&
          thread.providerInstanceId === row.provider_instance_id
        ) {
          const driver = ProviderDriverKind.make("dulli");
          const providerThread: OrchestrationV2ProviderThread = {
            id: ProviderThreadId.make(`migration:dulli:${row.thread_id}`),
            driver,
            providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
            providerSessionId: null,
            appThreadId: thread.id,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: row.session_file, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          };
          yield* sink.write({
            events: [
              {
                id: EventId.make(`migration:dulli:${row.thread_id}:native-thread`),
                type: "provider-thread.updated",
                threadId: thread.id,
                driver,
                providerInstanceId: providerThread.providerInstanceId,
                occurredAt: thread.updatedAt,
                payload: providerThread,
              },
              {
                id: EventId.make(`migration:dulli:${row.thread_id}:native-binding`),
                type: "thread.metadata-updated",
                threadId: thread.id,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: thread.updatedAt,
                payload: { ...thread, activeProviderThreadId: providerThread.id },
              },
            ],
          });
        }
        yield* sql`UPDATE dulli_fork_native_threads SET imported = 1 WHERE thread_id = ${row.thread_id}`;
      }),
    );
  }
});

/** Repairs only the frozen fork installation's old UUID cursors, not upstream Pi.
 * Called with configured Dulli homes by shared-session startup, after shell import. */
export const recoverDulliUuidCursors = Effect.fn(function* (agentDirs: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const detected = yield* sql`SELECT 1 FROM dulli_fork_migrations WHERE name = 'fork-detected'`;
  if (!detected.length) return;
  const rows = yield* sql<{
    thread_id: string;
    provider_instance_id: string;
    session_id: string;
    cwd: string;
  }>`
    SELECT r.thread_id, r.provider_instance_id, json_extract(r.resume_cursor_json, '$.piSessionId') AS session_id,
      coalesce(json_extract(t.payload_json, '$.worktreePath'), json_extract(r.runtime_payload_json, '$.cwd')) AS cwd
    FROM provider_session_runtime r JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
    WHERE r.provider_name = 'dulli' AND json_valid(r.resume_cursor_json)
      AND json_type(r.resume_cursor_json, '$.piSessionId') = 'text'
      AND json_extract(t.payload_json, '$.activeProviderThreadId') IS NULL
      AND NOT EXISTS (SELECT 1 FROM dulli_fork_native_threads n WHERE n.thread_id = r.thread_id)
    LIMIT 100
  `;
  for (const row of rows) {
    if (!row.cwd) continue;
    const file = yield* findDulliSessionFile(agentDirs, row.session_id, row.cwd);
    if (file === null) continue;
    yield* sql`INSERT OR IGNORE INTO dulli_fork_native_threads (thread_id, provider_instance_id, session_file)
      VALUES (${row.thread_id}, ${row.provider_instance_id}, ${file})`;
  }
  yield* restoreDulliNativeContinuity;
});
