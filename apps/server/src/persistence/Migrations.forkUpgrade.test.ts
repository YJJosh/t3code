import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";

it.effect("retires old fork threads and history without changing native providers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 72 });
    yield* sql`CREATE TABLE dulli_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, name TEXT NOT NULL)`;
    yield* sql`INSERT INTO dulli_sql_migrations (migration_id, name) VALUES
      (1, 'ProjectionThreadMessagePhase'), (2, 'DulliProviderIdentity'),
      (3, 'PiSessionsSettlement'), (4, 'DulliRunIsolation')`;
    for (const table of [
      "dulli_fork_migrations",
      "dulli_fork_native_threads",
      "dulli_projection_runs",
      "dulli_projection_transcript",
      "pi_sessions_settlement",
      "projection_thread_activities",
    ]) {
      yield* sql`CREATE TABLE ${sql(table)} (thread_id TEXT)`;
      yield* sql`INSERT INTO ${sql(table)} VALUES ('retired')`;
    }
    for (const [id, driver, instance] of [
      ["retired", "dulli", "custom-dulli"],
      ["native-pi", "pi", "pi"],
      ["native-claude", "claudeAgent", "claudeAgent"],
    ]) {
      const payload = JSON.stringify({
        id,
        providerInstanceId: instance,
        modelSelection: { instanceId: instance, model: "model" },
        title: id,
        settledOverride: null,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${id}, 'project', ${id}, ${driver}, ${instance}, 'full-access', 'default', '2026-01-01', '2026-01-01', ${payload})`;
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${id}, 'thread', ${id}, 0, 'thread.created', '2026-01-01', 'server', ${payload}, '{}', 2)`;
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at) VALUES (${id}, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${id}, ${id}, 'user', 0, '2026-01-01', '2026-01-01', ${JSON.stringify({ id, text: "searchable history", attachments: [] })})`;
    }
    const before =
      yield* sql`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id != 'retired' ORDER BY thread_id`;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id`,
      before,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT stream_id FROM orchestration_events WHERE aggregate_kind = 'thread' ORDER BY stream_id`,
      [{ stream_id: "native-claude" }, { stream_id: "native-pi" }],
    );
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_projection_messages`, 2);
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, 2);
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id FROM dulli_sql_migrations ORDER BY migration_id`,
      [1, 2, 3, 4, 5].map((migration_id) => ({ migration_id })),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'dulli_%' OR name = 'pi_sessions_settlement') AND name NOT IN ('dulli_sql_migrations', 'dulli_retirement_cleanup')`,
      [],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("fresh installs reserve old fork ids without creating retired schemas", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT migration_id, name FROM dulli_sql_migrations`, [
      { migration_id: 5, name: "RetireDulli" },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dulli_%'`,
      [{ name: "dulli_sql_migrations" }],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
