import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import * as ServerConfig from "../../../config.ts";
import { retiredDulliInstanceIds } from "../../retiredDulliSettings.ts";

const decodeSettings = Schema.decodeEffect(fromLenientJson(Schema.Unknown));
const encodeInstanceIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

// Retirement is a hard purge: soft deletion leaves removed-driver events available to replay.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let instanceIds: ReadonlyArray<string> = ["dulli"];
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  if (Option.isSome(config) && Option.isSome(fs)) {
    const settings = yield* fs.value
      .readFileString(config.value.settingsPath)
      .pipe(Effect.flatMap(decodeSettings), Effect.option);
    if (Option.isSome(settings)) instanceIds = retiredDulliInstanceIds(settings.value);
  }
  const encodedInstanceIds = yield* encodeInstanceIds(instanceIds);
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
  }
  yield* sql`INSERT OR IGNORE INTO retired_dulli_threads
    SELECT thread_id FROM orchestration_v2_projection_threads AS thread
    WHERE default_provider = 'dulli' OR provider_instance_id IN (SELECT value FROM json_each(${encodedInstanceIds}))
      OR active_provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads WHERE driver = 'dulli')`;
  // A native parent may have Dulli subagents or stale legacy bindings; neither owns that parent.
  yield* sql`INSERT OR IGNORE INTO retired_dulli_threads
    SELECT thread_id FROM projection_threads AS legacy
    WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS current WHERE current.thread_id = legacy.thread_id)
      AND (json_extract(model_selection_json, '$.instanceId') IN (SELECT value FROM json_each(${encodedInstanceIds}))
        OR thread_id IN (SELECT thread_id FROM provider_session_runtime WHERE provider_name = 'dulli' OR provider_instance_id IN (SELECT value FROM json_each(${encodedInstanceIds})))
        OR thread_id IN (SELECT thread_id FROM projection_thread_sessions WHERE provider_name = 'dulli' OR provider_instance_id IN (SELECT value FROM json_each(${encodedInstanceIds}))))`;
  yield* sql`CREATE TEMP TABLE retired_dulli_nodes (node_id TEXT PRIMARY KEY)`;
  yield* sql`INSERT OR IGNORE INTO retired_dulli_nodes
    SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE driver = 'dulli' OR provider_instance_id IN (SELECT value FROM json_each(${encodedInstanceIds}))`;
  yield* sql`INSERT OR IGNORE INTO retired_dulli_nodes
    SELECT node_id FROM orchestration_v2_projection_nodes WHERE node_id GLOB 'dulli:*'`;
  yield* sql`INSERT OR IGNORE INTO retired_dulli_nodes
    WITH RECURSIVE descendants(node_id) AS (
      SELECT node_id FROM retired_dulli_nodes
      UNION SELECT child.node_id FROM orchestration_v2_projection_nodes AS child JOIN descendants ON child.parent_node_id = descendants.node_id
    ) SELECT node_id FROM descendants`;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE node_id IN (SELECT node_id FROM retired_dulli_nodes) OR turn_item_id GLOB 'dulli:*'`;
  yield* sql`DELETE FROM orchestration_v2_projection_nodes WHERE node_id IN (SELECT node_id FROM retired_dulli_nodes)`;
  yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id IN (SELECT node_id FROM retired_dulli_nodes)`;
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
  yield* sql`DELETE FROM orchestration_events WHERE aggregate_kind = 'thread' AND (
    stream_id IN (SELECT thread_id FROM retired_dulli_threads)
    OR event_type GLOB 'dulli-*' OR event_type GLOB 'dulli.*'
    OR json_extract(metadata_json, '$.driver') = 'dulli'
    OR json_extract(metadata_json, '$.providerInstanceId') IN (SELECT value FROM json_each(${encodedInstanceIds}))
    OR json_extract(metadata_json, '$.nodeId') IN (SELECT node_id FROM retired_dulli_nodes)
    OR (event_type IN ('node.updated', 'subagent.updated', 'turn-item.updated') AND (
      json_extract(payload_json, '$.id') IN (SELECT node_id FROM retired_dulli_nodes)
      OR json_extract(payload_json, '$.nodeId') IN (SELECT node_id FROM retired_dulli_nodes)
    )))`;
  yield* sql`DELETE FROM orchestration_v2_events WHERE driver = 'dulli' OR provider_instance_id IN (SELECT value FROM json_each(${encodedInstanceIds})) OR node_id IN (SELECT node_id FROM retired_dulli_nodes)`;
  for (const name of [
    "scheduled_task_webhook_deliveries",
    "scheduled_task_webhook_relay_deliveries",
    "scheduled_task_webhook_replay_keys",
    "scheduled_task_webhook_pending",
  ]) {
    yield* sql`DELETE FROM ${sql(name)} WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads) OR json_extract(model_selection_json, '$.instanceId') IN (SELECT value FROM json_each(${encodedInstanceIds})))`;
  }
  yield* sql`DELETE FROM scheduled_tasks WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads) OR json_extract(model_selection_json, '$.instanceId') IN (SELECT value FROM json_each(${encodedInstanceIds}))`;
  yield* sql`DELETE FROM projection_threads WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads)`;
  yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id IN (SELECT thread_id FROM retired_dulli_threads)`;
  yield* sql`UPDATE projection_projects SET default_model_selection_json = NULL WHERE json_extract(default_model_selection_json, '$.instanceId') IN (SELECT value FROM json_each(${encodedInstanceIds}))`;
  yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.defaultModelSelection', NULL)
    WHERE aggregate_kind = 'project' AND json_extract(payload_json, '$.defaultModelSelection.instanceId') IN (SELECT value FROM json_each(${encodedInstanceIds}))`;
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
  yield* sql`DROP TABLE retired_dulli_nodes`;
  yield* sql`DROP TABLE retired_dulli_threads`;
});
