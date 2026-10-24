import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { dulliMigrationManifest, migrationManifest, runMigrations } from "../../Migrations.ts";

const message = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-01-01T00:00:00.000Z";
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('message', 'thread', 'assistant', 'Preserved answer', 0, ${now}, ${now})`;
});

const verifyUpgrade = (expectedPhase: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly phase: string | null; readonly text: string }>`
    SELECT phase, text FROM projection_thread_messages WHERE message_id = 'message'
  `;
    assert.deepEqual(rows, [{ phase: expectedPhase, text: "Preserved answer" }]);
    const tracking = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
    assert.deepEqual(
      tracking.map((row) => [row.migration_id, row.name] as const),
      migrationManifest,
    );
    const v2 =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_threads'`;
    assert.equal(v2.length, 1);
    assert.deepEqual(yield* runMigrations(), []);
  });

describe("message phase migration in the fork ledger", () => {
  it.effect("migrates a fresh database and leaves legacy message phases unknown", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* message;
      yield* runMigrations();
      yield* verifyUpgrade(null);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([50, 55])(
    "reconciles the fork phase migration at ID %s without skipping V2",
    (id) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: id === 50 ? 49 : 54 });
        yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN phase TEXT`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, 'ProjectionThreadMessagePhase')`;
        yield* message;
        yield* sql`UPDATE projection_thread_messages SET phase = 'final_answer' WHERE message_id = 'message'`;
        const executed = yield* runMigrations();
        assert.deepEqual(executed, [
          ...migrationManifest.filter(([migrationId]) => migrationId >= id),
          ...dulliMigrationManifest,
        ]);
        assert.isTrue(
          executed.some(([migrationId, name]) => migrationId === 55 && name === "OrchestrationV2"),
        );
        yield* verifyUpgrade("final_answer");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs all pending fork migrations on an upstream database at 62", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* message;
      assert.deepEqual(yield* runMigrations(), [
        ...migrationManifest.filter(([id]) => id > 62),
        ...dulliMigrationManifest,
      ]);
      yield* verifyUpgrade(null);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
