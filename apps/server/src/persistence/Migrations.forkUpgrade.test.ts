import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";

it.effect("moves old fork threads to Pi and archives what this release cannot read", () =>
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
      "dulli_projection_runs",
      "pi_sessions_settlement",
      "projection_thread_activities",
    ]) {
      yield* sql`CREATE TABLE ${sql(table)} (thread_id TEXT)`;
      yield* sql`INSERT INTO ${sql(table)} VALUES ('old-fork')`;
    }
    for (const [id, driver, instance] of [
      ["old-fork", "dulli", "custom-dulli"],
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
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${id}, ${id}, 'user', 0, '2026-01-01', '2026-01-01', ${JSON.stringify({ id, text: 'set "driver":"dulli" in the config', attachments: [] })})`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json, driver, provider_instance_id)
      VALUES ('dulli-child', 'native-claude', 'root', 'dulli', 'provider_native', 'completed', '2026-01-01', '{"driver":"dulli","providerInstanceId":"custom-dulli"}', 'dulli', 'custom-dulli')`;
    yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES ('child-event', 'thread', 'native-claude', 1, 'subagent.updated', '2026-01-01', 'provider', '{"id":"dulli-child"}', '{"driver":"dulli"}', 2),
        ('transcript-event', 'thread', 'old-fork', 1, 'dulli-transcript.updated', '2026-01-01', 'provider', '{"text":"child"}', '{}', 2)`;
    const messagesBefore =
      yield* sql`SELECT message_id, payload_json FROM orchestration_v2_projection_messages ORDER BY message_id`;
    yield* runMigrations();

    assert.deepStrictEqual(
      yield* sql`SELECT thread_id, default_provider, provider_instance_id FROM orchestration_v2_projection_threads ORDER BY thread_id`,
      [
        {
          thread_id: "native-claude",
          default_provider: "claudeAgent",
          provider_instance_id: "claudeAgent",
        },
        { thread_id: "native-pi", default_provider: "pi", provider_instance_id: "pi" },
        { thread_id: "old-fork", default_provider: "pi", provider_instance_id: "custom-dulli" },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT message_id, payload_json FROM orchestration_v2_projection_messages ORDER BY message_id`,
      messagesBefore,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT driver, provider, provider_instance_id, payload_json FROM orchestration_v2_projection_subagents`,
      [
        {
          driver: "pi",
          provider: "pi",
          provider_instance_id: "custom-dulli",
          payload_json: '{"driver":"pi","providerInstanceId":"custom-dulli"}',
        },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT event_id, metadata_json FROM orchestration_events WHERE aggregate_kind = 'thread' ORDER BY event_id`,
      [
        { event_id: "child-event", metadata_json: '{"driver":"pi"}' },
        { event_id: "native-claude", metadata_json: "{}" },
        { event_id: "native-pi", metadata_json: "{}" },
        { event_id: "old-fork", metadata_json: "{}" },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT event_id, event_type, payload_json FROM dulli_archived_events`,
      [
        {
          event_id: "transcript-event",
          event_type: "dulli-transcript.updated",
          payload_json: '{"text":"child"}',
        },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND (name GLOB 'dulli_*' OR name IN ('pi_sessions_settlement', 'projection_thread_activities')) ORDER BY name`,
      [
        "dulli_archived_events",
        "dulli_archived_pi_sessions_settlement",
        "dulli_archived_thread_activities",
        "dulli_fork_migrations",
        "dulli_projection_runs",
        "dulli_sql_migrations",
      ].map((name) => ({ name })),
    );
    assert.deepStrictEqual(yield* sql`SELECT thread_id FROM dulli_archived_thread_activities`, [
      { thread_id: "old-fork" },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id FROM dulli_sql_migrations ORDER BY migration_id`,
      [1, 2, 3, 4, 5].map((migration_id) => ({ migration_id })),
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("fresh installs reserve old fork ids and create no archive", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT migration_id, name FROM dulli_sql_migrations`, [
      { migration_id: 5, name: "MoveDulliToPi" },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dulli_%'`,
      [{ name: "dulli_sql_migrations" }],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
