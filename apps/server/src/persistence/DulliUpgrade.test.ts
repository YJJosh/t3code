// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { backupBeforeDulliUpgrade, finishDulliUpgrade } from "./DulliUpgrade.ts";
import { withDulliOnPi } from "./dulliSettings.ts";

it.effect("backs up committed WAL data before the upgrade without replacing the first backup", () =>
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
    yield* backupBeforeDulliUpgrade(dbPath);
    const snapshot = yield* Effect.acquireRelease(
      Effect.sync(
        () => new NodeSqlite.DatabaseSync(`${dbPath}.before-dulli-upgrade`, { readOnly: true }),
      ),
      (db) => Effect.sync(() => db.close()),
    );
    assert.equal(
      snapshot.prepare("SELECT migration_id FROM dulli_sql_migrations").get()?.migration_id,
      4,
    );
    source.exec("INSERT INTO dulli_sql_migrations VALUES (5)");
    yield* backupBeforeDulliUpgrade(dbPath);
    assert.equal(
      snapshot.prepare("SELECT count(*) AS count FROM dulli_sql_migrations").get()?.count,
      1,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("moves Dulli instances to Pi under the same id and keeps every other setting", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dulli-settings-" });
    const settingsPath = path.join(directory, "settings.json");
    const settings = {
      providerInstances: {
        old: {
          driver: "dulli",
          enabled: true,
          config: { binaryPath: "/opt/pi", profile: "obsolete" },
        },
        named: { driver: "dulli", displayName: "Work Pi" },
        pi: { driver: "pi", config: { binaryPath: "pi" } },
      },
      defaultModelSelection: { instanceId: "old", model: "anthropic/claude" },
      projectSettingsOverrides: { project: { providerInstances: { old: { enabled: false } } } },
      unknownKey: { driver: "dulli", text: "keep opaque data" },
    };
    const expected = {
      ...settings,
      providerInstances: {
        old: {
          driver: "pi",
          enabled: true,
          displayName: "Pi (Dulli)",
          config: { binaryPath: "/opt/pi" },
        },
        named: { driver: "pi", displayName: "Work Pi" },
        pi: settings.providerInstances.pi,
      },
    };
    assert.deepStrictEqual(withDulliOnPi(settings), expected);
    yield* fs.writeFileString(settingsPath, JSON.stringify(settings));
    const dbPath = path.join(directory, "statev2.sqlite");
    yield* finishDulliUpgrade(dbPath);
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(settingsPath)), expected);
    yield* finishDulliUpgrade(dbPath);
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(`${settingsPath}.before-dulli-upgrade`)),
      settings,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
