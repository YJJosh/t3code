// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { withoutRetiredDulliSettings } from "./retiredDulliSettings.ts";

const decodeSettings = Schema.decodeEffect(fromLenientJson(Schema.Unknown));
const encodeSettings = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export const backupBeforeDulliRetirement = Effect.fn("DulliUpgrade.backupBeforeRetirement")(
  function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(dbPath))) return;
    const backupPath = `${dbPath}.before-dulli-retirement`;
    if (yield* fs.exists(backupPath)) return;
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: path.dirname(dbPath),
      prefix: ".dulli-retirement-",
    });
    const snapshotPath = path.join(directory, "snapshot.sqlite");
    const backedUp = yield* Effect.tryPromise({
      try: async () => {
        const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          database.exec("BEGIN");
          const tables = new Set(
            database
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
              .all()
              .map((row) => row.name),
          );
          if (!tables.has("dulli_sql_migrations") && !tables.has("dulli_fork_migrations"))
            return false;
          if (
            tables.has("dulli_sql_migrations") &&
            database.prepare("SELECT 1 FROM dulli_sql_migrations WHERE migration_id = 5").get()
          )
            return false;
          await NodeSqlite.backup(database, snapshotPath);
          return true;
        } finally {
          database.close();
        }
      },
      catch: (cause) =>
        new Migrator.MigrationError({
          kind: "Failed",
          message: "Could not safely retire Dulli; startup will retry the upgrade.",
          cause,
        }),
    });
    if (!backedUp) return;
    yield* fs.chmod(snapshotPath, 0o600);
    yield* fs.link(snapshotPath, backupPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );
    yield* Effect.log("Saved database backup before retiring Dulli", { backupPath });
  },
  Effect.scoped,
);

export const finishDulliRetirement = Effect.fn("DulliUpgrade.finishRetirement")(
  function* (dbPath: string) {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(dbPath);
    const settingsPath = path.join(directory, "settings.json");
    if (yield* fs.exists(settingsPath)) {
      const raw = yield* fs.readFileString(settingsPath);
      const parsed = yield* decodeSettings(raw).pipe(Effect.option);
      if (parsed._tag === "Some") {
        const cleaned = withoutRetiredDulliSettings(parsed.value);
        const cleanedJson = yield* encodeSettings(cleaned);
        if (cleanedJson !== (yield* encodeSettings(parsed.value))) {
          yield* fs
            .writeFileString(`${settingsPath}.before-dulli-retirement`, raw, {
              flag: "wx",
              mode: 0o600,
            })
            .pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "AlreadyExists",
                () => Effect.void,
              ),
            );
          yield* writeFileStringAtomically({
            filePath: settingsPath,
            contents: `${cleanedJson}\n`,
          });
        }
      }
    }
    const queued =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dulli_retirement_cleanup'`;
    if (queued.length === 0) return;
    const threads = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM dulli_retirement_cleanup`;
    const readDirectory = Effect.fn("DulliUpgrade.readDirectory")(function* (directory: string) {
      return yield* fs.readDirectory(directory).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed([]),
        ),
      );
    });
    const attachmentsDir = path.join(directory, "attachments");
    const segments = new Set(
      threads.map(({ thread_id }) => toSafeThreadAttachmentSegment(thread_id)),
    );
    for (const file of yield* readDirectory(attachmentsDir)) {
      const id = file.split(".")[0]!;
      const segment = parseThreadSegmentFromAttachmentId(id);
      if (segment === null || !segments.has(segment)) continue;
      // Forked conversations can share files. A surviving reference wins over ownership.
      const referenced =
        yield* sql`SELECT 1 FROM orchestration_v2_projection_messages WHERE instr(payload_json, ${id}) > 0
      UNION ALL SELECT 1 FROM orchestration_v2_projection_turn_items WHERE instr(payload_json, ${id}) > 0
      UNION ALL SELECT 1 FROM projection_thread_messages WHERE instr(attachments_json, ${id}) > 0 LIMIT 1`;
      if (referenced.length === 0)
        yield* fs.remove(path.join(attachmentsDir, file), { force: true });
    }
    const logsDir = path.join(directory, "logs", "terminals");
    const logNames = yield* readDirectory(logsDir);
    for (const { thread_id } of threads) {
      const prefixes = [
        `terminal_${Base64Url.encode(thread_id)}`,
        `terminal_sha256.${NodeCrypto.createHash("sha256").update(thread_id).digest("base64url")}`,
      ];
      const legacy = `${thread_id.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`;
      for (const name of logNames.filter(
        (name) =>
          name === legacy ||
          prefixes.some((prefix) => name === `${prefix}.log` || name.startsWith(`${prefix}_`)),
      )) {
        yield* fs.remove(path.join(logsDir, name), { force: true });
      }
    }
    yield* sql`DROP TABLE dulli_retirement_cleanup`;
  },
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new Migrator.MigrationError({
            kind: "Failed",
            message: "Could not safely retire Dulli; startup will retry the upgrade.",
            cause,
          }),
      ),
    ),
);
