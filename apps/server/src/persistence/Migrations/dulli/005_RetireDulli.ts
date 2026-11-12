import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Retirement is a hard purge: soft deletion leaves removed-driver events available to replay.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  const names = new Set(tables.map((row) => row.name));
  yield* sql`CREATE TEMP TABLE retired_dulli_threads (thread_id TEXT PRIMARY KEY)`;
  const threadTables: string[] = [];
  for (const { name } of tables) {
    if (
      !(
        name.startsWith("orchestration_v2_") ||
        name.startsWith("projection_") ||
        name === "provider_session_runtime"
      )
    )
      continue;
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(${sql(name)})`;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("thread_id")) continue;
    threadTables.push(name);
    const identities = [
      "default_provider",
      "driver",
      "provider_name",
      "provider_instance_id",
    ].filter((column) => columnNames.has(column));
    for (const column of identities) {
      yield* sql`INSERT OR IGNORE INTO retired_dulli_threads SELECT thread_id FROM ${sql(name)} WHERE ${sql(column)} = 'dulli' AND thread_id IS NOT NULL`;
    }
  }
  yield* sql`INSERT OR IGNORE INTO retired_dulli_threads
    SELECT thread_id FROM projection_threads WHERE json_extract(model_selection_json, '$.instanceId') = 'dulli'`;
  yield* sql`INSERT OR IGNORE INTO retired_dulli_threads
    SELECT stream_id FROM orchestration_events WHERE aggregate_kind = 'thread'
      AND (json_extract(metadata_json, '$.driver') = 'dulli' OR json_extract(metadata_json, '$.providerInstanceId') = 'dulli')`;
  const retired = yield* sql`SELECT 1 FROM retired_dulli_threads LIMIT 1`;
  if (retired.length > 0) {
    yield* sql`CREATE TABLE IF NOT EXISTS dulli_retirement_cleanup (thread_id TEXT PRIMARY KEY)`;
    yield* sql`INSERT OR IGNORE INTO dulli_retirement_cleanup SELECT thread_id FROM retired_dulli_threads`;
  }
  // Delete dependent rows before shells; remove V1 sources too so lazy import cannot revive them.
  for (const name of threadTables.filter(
    (name) => name !== "projection_threads" && name !== "orchestration_v2_projection_threads",
  )) {
    yield* sql`DELETE FROM ${sql(name)} WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads)`;
  }
  yield* sql`DELETE FROM orchestration_command_receipts WHERE aggregate_kind = 'thread' AND aggregate_id IN (SELECT thread_id FROM retired_dulli_threads)`;
  yield* sql`DELETE FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM retired_dulli_threads)`;
  yield* sql`DELETE FROM scheduled_tasks WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads) OR json_extract(model_selection_json, '$.instanceId') = 'dulli'`;
  yield* sql`DELETE FROM projection_threads WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads)`;
  yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads)`;
  yield* sql`UPDATE projection_projects SET default_model_selection_json = NULL WHERE json_extract(default_model_selection_json, '$.instanceId') = 'dulli'`;
  yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.defaultModelSelection', NULL)
    WHERE aggregate_kind = 'project' AND json_extract(payload_json, '$.defaultModelSelection.instanceId') = 'dulli'`;
  for (const name of [
    "pi_sessions_settlement",
    "dulli_fork_migrations",
    "dulli_fork_native_threads",
    "dulli_projection_runs",
    "dulli_projection_transcript",
    "projection_thread_activities",
  ]) {
    if (names.has(name)) yield* sql`DROP TABLE ${sql(name)}`;
  }
  yield* sql`DROP TABLE retired_dulli_threads`;
});
