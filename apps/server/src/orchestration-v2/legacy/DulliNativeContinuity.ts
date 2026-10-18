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
    payload_json: string;
  }>`
    SELECT legacy.thread_id, legacy.provider_instance_id, legacy.session_file, thread.payload_json
    FROM dulli_fork_native_threads AS legacy
    INNER JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = legacy.thread_id
    WHERE legacy.imported = 0
  `;
  for (const row of rows) {
    const thread = yield* decodeThread(row.payload_json);
    yield* sql.withTransaction(
      Effect.gen(function* () {
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
