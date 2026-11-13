import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const DRIVER_COLUMNS = new Set(["driver", "provider", "provider_name", "default_provider"]);
const DRIVER_KEYS = ["driver", "provider", "defaultProvider", "providerName"];
const RENAMED_TABLES = [
  ["pi_sessions_settlement", "dulli_archived_pi_sessions_settlement"],
  ["projection_thread_activities", "dulli_archived_thread_activities"],
] as const;

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

// Dulli ran the user's own Pi, so its threads continue on native Pi, which resumes the same
// session files. Nothing is deleted: rows this release cannot read move to dulli_archived_* tables.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const oldEvents = sql`event_type GLOB 'dulli-*' OR event_type GLOB 'dulli.*'`;
  if ((yield* sql`SELECT 1 FROM orchestration_events WHERE ${oldEvents} LIMIT 1`).length > 0) {
    yield* sql`CREATE TABLE IF NOT EXISTS dulli_archived_events AS SELECT * FROM orchestration_events WHERE 0`;
    yield* sql`INSERT INTO dulli_archived_events SELECT * FROM orchestration_events WHERE ${oldEvents}`;
    yield* sql`DELETE FROM orchestration_events WHERE ${oldEvents}`;
  }
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT GLOB 'dulli_*' AND name NOT GLOB 'sqlite_*'`;
  for (const { name: table } of tables) {
    const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
    for (const { name: column } of columns) {
      if (DRIVER_COLUMNS.has(column)) {
        yield* sql.unsafe(
          `UPDATE ${quote(table)} SET ${quote(column)} = 'pi' WHERE ${quote(column)} = 'dulli'`,
        );
      } else if (column.endsWith("_json")) {
        // Quotes inside JSON string values are escaped, so these exact keys never match text.
        const rewritten = DRIVER_KEYS.reduce(
          (value, key) => `replace(${value}, '"${key}":"dulli"', '"${key}":"pi"')`,
          quote(column),
        );
        yield* sql.unsafe(
          `UPDATE ${quote(table)} SET ${quote(column)} = ${rewritten} WHERE instr(${quote(column)}, ':"dulli"') > 0`,
        );
      }
    }
  }
  const names = new Set(tables.map((row) => row.name));
  for (const [from, to] of RENAMED_TABLES) {
    if (names.has(from)) yield* sql.unsafe(`ALTER TABLE ${quote(from)} RENAME TO ${quote(to)}`);
  }
});
