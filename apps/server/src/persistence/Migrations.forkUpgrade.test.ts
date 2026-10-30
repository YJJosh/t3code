import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import {
  dulliMigrationEntries,
  dulliMigrationManifest,
  migrationManifest,
  runMigrations,
} from "./Migrations.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const now = "2026-01-01T00:00:00.000Z";

const verifyLedgers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, manifest] of [
    ["effect_sql_migrations", migrationManifest],
    ["dulli_sql_migrations", dulliMigrationManifest],
  ] as const) {
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id`,
      manifest.map(([migration_id, name]) => ({ migration_id, name })),
    );
  }
});

const verifyNoOp = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const before = yield* sql`SELECT total_changes() AS changes`;
  assert.deepStrictEqual(yield* runMigrations(), []);
  assert.deepStrictEqual(yield* sql`SELECT total_changes() AS changes`, before);
});

it.effect.each(["released", "dev"] as const)(
  "upgrades the %s fork ledger without skipping upstream migrations or rewriting migrated Dulli data",
  (layout) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: layout === "released" ? 62 : 67 });
      for (const [id, name, migration] of dulliMigrationEntries) {
        yield* sql.withTransaction(migration);
        const oldId = id + (layout === "released" ? 62 : 67);
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${oldId}, ${name})`;
      }
      // The frozen identity decision must not rename later upstream Pi sessions on replay.
      yield* sql`INSERT INTO provider_session_runtime
      (thread_id, provider_name, provider_instance_id, adapter_key, status, last_seen_at)
      VALUES ('upstream-pi', 'pi', 'pi', 'pi', 'stopped', ${now})`;
      yield* sql`INSERT INTO dulli_projection_runs VALUES ('run', 'thread', 'native-run', '{"driver":"dulli"}')`;
      yield* sql`INSERT INTO dulli_projection_transcript VALUES ('item', 'thread', 'run', 1, '{"text":"Saved answer"}')`;
      yield* sql`INSERT INTO pi_sessions_settlement VALUES ('environment', 'thread', 'session', '{"baseline":"saved"}')`;
      const snapshot = Effect.gen(function* () {
        return {
          runtime: yield* sql`SELECT * FROM provider_session_runtime`,
          runs: yield* sql`SELECT * FROM dulli_projection_runs`,
          transcript: yield* sql`SELECT * FROM dulli_projection_transcript`,
          settlements: yield* sql`SELECT * FROM pi_sessions_settlement`,
          markers: yield* sql`SELECT * FROM dulli_fork_migrations ORDER BY name`,
        };
      });
      const before = yield* snapshot;
      assert.deepStrictEqual(yield* runMigrations(), [
        ...migrationManifest.filter(([id]) => id > (layout === "released" ? 62 : 67)),
        ...dulliMigrationManifest,
      ]);
      assert.deepStrictEqual(yield* snapshot, before);
      yield* verifyLedgers;
      yield* verifyNoOp;
    }).pipe(Effect.provide(database)),
);

it.effect("adds only fork migrations to the current upstream ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: migrationManifest.at(-1)![0] });
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(yield* runMigrations(), dulliMigrationManifest);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
    yield* verifyLedgers;
    yield* verifyNoOp;
  }).pipe(Effect.provide(database)),
);

it.effect("installs upstream and fork migrations on a fresh database once", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* runMigrations(), [
      ...migrationManifest,
      ...dulliMigrationManifest,
    ]);
    yield* verifyLedgers;
    yield* verifyNoOp;
  }).pipe(Effect.provide(database)),
);

it.effect("never removes another migration by id alone, including upstream 68–71", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 67 });
    for (const [id, name] of dulliMigrationManifest) {
      // Different names in the historical fork slots must survive the exact-pair cleanup.
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id + 67}, ${`${name}Upstream`})`;
    }
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const exit = yield* Effect.exit(runMigrations());
    assert.isTrue(Exit.isFailure(exit));
    assert.include(
      String(exit),
      "68_ShellStopRequestIndex (recorded: ProjectionThreadMessagePhaseUpstream)",
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
  }).pipe(Effect.provide(database)),
);

it.effect("an upstream cutoff never installs the fork schema or ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 67 });
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name IN ('dulli_sql_migrations', 'dulli_projection_runs')`,
      [],
    );
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_messages)`;
    assert.isFalse(columns.some(({ name }) => name === "phase"));
  }).pipe(Effect.provide(database)),
);
