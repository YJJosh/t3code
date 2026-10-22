import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("063_DropUnusedV1Projections", (it) => {
  it.effect("drops V1 projections nothing reads and keeps the transcript import sources", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-1', 'thread-1', 'user', 'hello', 0, '2026-01-01', '2026-01-01')
      `;

      yield* runMigrations({ toMigrationInclusive: 63 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tables = new Set(rows.map((row) => row.name));
      for (const dropped of [
        "projection_thread_activities",
        "projection_turns",
        "projection_thread_proposed_plans",
        "projection_pending_approvals",
        "projection_state",
        "checkpoint_diff_blobs",
      ]) {
        assert.isFalse(tables.has(dropped), dropped);
      }
      for (const kept of [
        "projection_threads",
        "projection_thread_messages",
        "projection_thread_pull_requests",
      ]) {
        assert.isTrue(tables.has(kept), kept);
      }
      assert.deepEqual(yield* sql`SELECT message_id FROM projection_thread_messages`, [
        { message_id: "message-1" },
      ]);
    }),
  );
});

const hasActivities = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_activities'`;
  return rows.length > 0;
});

const forkWithTaskRow = (imported: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 62 });
    yield* sql`INSERT INTO dulli_fork_migrations VALUES ('fork-detected')`;
    if (imported) {
      yield* sql`INSERT INTO dulli_fork_migrations VALUES ('subagent-history-v1:thread-1')`;
    }
    yield* sql`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('activity-1', 'thread-1', 'info', 'task.started', 'Task', '{}', '2026-01-01')
    `;
    yield* runMigrations({ toMigrationInclusive: 63 });
  });

describe("063_DropUnusedV1Projections on Dulli fork databases", () => {
  it.effect("keeps activities while old Pi subagent history is not imported yet", () =>
    Effect.gen(function* () {
      yield* forkWithTaskRow(false);
      assert.isTrue(yield* hasActivities);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops activities once every thread's history is imported", () =>
    Effect.gen(function* () {
      yield* forkWithTaskRow(true);
      assert.isFalse(yield* hasActivities);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
