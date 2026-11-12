// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { backupBeforeDulliRetirement, finishDulliRetirement } from "./DulliUpgrade.ts";
import { runMigrations } from "./Migrations.ts";
import { withoutRetiredDulliSettings } from "./retiredDulliSettings.ts";

it.effect("backs up committed WAL data before retirement without replacing the first backup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dulli-upgrade-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    const source = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath)),
      (db) => Effect.sync(() => db.close()),
    );
    source.exec(
      "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE dulli_sql_migrations (migration_id INTEGER PRIMARY KEY); INSERT INTO dulli_sql_migrations VALUES (4)",
    );
    yield* backupBeforeDulliRetirement(dbPath);
    const snapshot = yield* Effect.acquireRelease(
      Effect.sync(
        () => new NodeSqlite.DatabaseSync(`${dbPath}.before-dulli-retirement`, { readOnly: true }),
      ),
      (db) => Effect.sync(() => db.close()),
    );
    assert.equal(
      snapshot.prepare("SELECT migration_id FROM dulli_sql_migrations").get()?.migration_id,
      4,
    );
    source.exec("INSERT INTO dulli_sql_migrations VALUES (5)");
    yield* backupBeforeDulliRetirement(dbPath);
    assert.equal(
      snapshot.prepare("SELECT count(*) AS count FROM dulli_sql_migrations").get()?.count,
      1,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("preserves other settings and retries file cleanup after interruption", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dulli-cleanup-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    const settingsPath = path.join(directory, "settings.json");
    const settings = {
      providerInstances: {
        old: { driver: "dulli", config: { profile: "obsolete" } },
        pi: { driver: "pi", config: { binaryPath: "pi" } },
        future: { driver: "future", config: {} },
      },
      defaultModelSelection: { instanceId: "old", model: "retired" },
      textGenerationModelSelection: { instanceId: "pi", model: "native" },
      projectSettingsOverrides: {
        project: {
          defaultModelSelection: { instanceId: "old", model: "retired" },
          providerInstances: { old: { enabled: true }, pi: { enabled: false } },
          futureKey: 42,
        },
      },
      unknownKey: { driver: "dulli", text: "keep opaque data" },
    };
    const expected = {
      providerInstances: {
        pi: settings.providerInstances.pi,
        future: settings.providerInstances.future,
      },
      textGenerationModelSelection: settings.textGenerationModelSelection,
      projectSettingsOverrides: {
        project: { providerInstances: { pi: { enabled: false } }, futureKey: 42 },
      },
      unknownKey: settings.unknownKey,
    };
    assert.deepStrictEqual(withoutRetiredDulliSettings(settings), expected);
    yield* fs.writeFileString(settingsPath, JSON.stringify(settings));
    yield* runMigrations();
    yield* sql`CREATE TABLE dulli_retirement_cleanup (thread_id TEXT PRIMARY KEY)`;
    yield* sql`INSERT INTO dulli_retirement_cleanup VALUES ('retired')`;
    const attachments = path.join(directory, "attachments");
    const logs = path.join(directory, "logs", "terminals");
    yield* fs.makeDirectory(attachments);
    yield* fs.makeDirectory(path.dirname(logs));
    yield* fs.writeFileString(logs, "simulate interrupted disk cleanup");
    const owned = "retired-00000000-0000-0000-0000-000000000001-png";
    const shared = "retired-00000000-0000-0000-0000-000000000002-png";
    yield* fs.writeFileString(path.join(attachments, `${owned}.png`), "owned");
    yield* fs.writeFileString(path.join(attachments, `${shared}.png`), "shared");
    yield* fs.writeFileString(path.join(attachments, "other.png"), "unrelated");
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('shared', 'survivor', 'user', 0, '2026-01-01', '2026-01-01', ${JSON.stringify({ attachments: [{ id: shared }] })})`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(finishDulliRetirement(dbPath))));
    assert.lengthOf(yield* sql`SELECT * FROM dulli_retirement_cleanup`, 1);
    yield* fs.remove(logs);
    yield* fs.makeDirectory(logs);
    yield* fs.writeFileString(path.join(logs, "retired.log"), "old history");
    yield* fs.writeFileString(path.join(logs, "survivor.log"), "keep history");
    yield* finishDulliRetirement(dbPath);
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(settingsPath)), expected);
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(`${settingsPath}.before-dulli-retirement`)),
      settings,
    );
    assert.deepStrictEqual(
      (yield* fs.readDirectory(attachments)).toSorted(),
      [`${shared}.png`, "other.png"].toSorted(),
    );
    assert.deepStrictEqual(yield* fs.readDirectory(logs), ["survivor.log"]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'dulli_retirement_cleanup'`,
      [],
    );
    yield* finishDulliRetirement(dbPath);
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(`${settingsPath}.before-dulli-retirement`)),
      settings,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    Effect.provide(NodeServices.layer),
  ),
);
