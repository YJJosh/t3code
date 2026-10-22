import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const now = "2026-01-01T00:00:00.000Z";

it.effect(
  "upgrades the released fork 63–66 ledger without skipping upstream migrations or rewriting migrated Dulli data",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      for (const [id, name, migration] of migrationEntries.filter(([id]) => id >= 68)) {
        yield* sql.withTransaction(migration);
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id - 5}, ${name})`;
      }
      // The identity migration has already frozen its routing decision. A later
      // upstream Pi session must remain Pi when the fork migration is re-registered.
      yield* sql`INSERT INTO provider_session_runtime
      (thread_id, provider_name, provider_instance_id, adapter_key, status, last_seen_at)
      VALUES ('upstream-pi', 'pi', 'pi', 'pi', 'stopped', ${now})`;
      yield* sql`INSERT INTO dulli_projection_runs VALUES ('run', 'thread', 'native-run', '{"driver":"dulli"}')`;
      yield* sql`INSERT INTO dulli_projection_transcript VALUES ('item', 'thread', 'run', 1, '{"text":"Saved answer"}')`;
      yield* sql`INSERT INTO pi_sessions_settlement VALUES ('environment', 'thread', 'session', '{"baseline":"saved"}')`;
      const before = {
        runtime: yield* sql`SELECT * FROM provider_session_runtime`,
        runs: yield* sql`SELECT * FROM dulli_projection_runs`,
        transcript: yield* sql`SELECT * FROM dulli_projection_transcript`,
        settlements: yield* sql`SELECT * FROM pi_sessions_settlement`,
        markers: yield* sql`SELECT * FROM dulli_fork_migrations ORDER BY name`,
      };
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 63),
      );
      assert.deepStrictEqual(
        {
          runtime: yield* sql`SELECT * FROM provider_session_runtime`,
          runs: yield* sql`SELECT * FROM dulli_projection_runs`,
          transcript: yield* sql`SELECT * FROM dulli_projection_transcript`,
          settlements: yield* sql`SELECT * FROM pi_sessions_settlement`,
          markers: yield* sql`SELECT * FROM dulli_fork_migrations ORDER BY name`,
        },
        before,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 63 ORDER BY migration_id`,
        migrationManifest
          .filter(([id]) => id >= 63)
          .map(([migration_id, name]) => ({ migration_id, name })),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(database)),
);

it.effect("adds only fork migrations to an upstream v0.1.1 ledger", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 67 });
    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id >= 68),
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);

it.effect("installs upstream and fork migrations on a fresh database once", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);
