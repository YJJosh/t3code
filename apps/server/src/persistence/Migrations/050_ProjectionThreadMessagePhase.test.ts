import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "055_ProjectionThreadMessagePhase",
  (it) => {
    it.effect("leaves existing message phases unknown and preserves their text", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('old-message', 'old-thread', 'assistant', 'Legacy answer', 0, ${now}, ${now})
      `;
        yield* runMigrations({ toMigrationInclusive: 55 });
        const rows = yield* sql<{ readonly phase: string | null; readonly text: string }>`
        SELECT phase, text FROM projection_thread_messages WHERE message_id = 'old-message'
      `;
        assert.deepEqual(rows, [{ phase: null, text: "Legacy answer" }]);
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      }),
    );
  },
);

it.layer(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "055 legacy fork upgrade",
  (it) => {
    it.effect("upgrades fork databases whose old migration 50 collides with upstream", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN phase TEXT`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (50, 'ProjectionThreadMessagePhase')`;
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, phase, text, is_streaming, created_at, updated_at)
        VALUES ('fork-message', 'fork-thread', 'assistant', 'final_answer', 'Fork answer', 0, ${now}, ${now})`;
        assert.deepEqual(
          (yield* runMigrations()).map(([id]) => id),
          [50, 51, 52, 53, 54, 55],
        );
        const rows = yield* sql<{
          readonly phase: string;
          readonly text: string;
        }>`SELECT phase, text FROM projection_thread_messages WHERE message_id = 'fork-message'`;
        assert.deepEqual(rows, [{ phase: "final_answer", text: "Fork answer" }]);
        const tracking = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 50`;
        assert.deepEqual(tracking, [{ name: "ProjectionThreadPullRequests" }]);
        assert.deepEqual(yield* runMigrations(), []);
      }),
    );
  },
);
