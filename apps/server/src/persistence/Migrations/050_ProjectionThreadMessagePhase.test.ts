import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("050_ProjectionThreadMessagePhase", (it) => {
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
      yield* runMigrations({ toMigrationInclusive: 50 });
      const rows = yield* sql<{ readonly phase: string | null; readonly text: string }>`
        SELECT phase, text FROM projection_thread_messages WHERE message_id = 'old-message'
      `;
      assert.deepEqual(rows, [{ phase: null, text: "Legacy answer" }]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 50 }), []);
    }),
  );
});
