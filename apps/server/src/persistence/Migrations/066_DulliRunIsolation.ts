import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Move only the old Pi bridge's identities, never native or app-owned T3 agents.
 * Rewrite their event kinds too: projection rebuild and old client cursors must
 * not resurrect upstream subagents. Keep sequence numbers/receipts unchanged. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS dulli_projection_runs (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, native_run_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, UNIQUE(thread_id, native_run_id))`;
  yield* sql`CREATE INDEX IF NOT EXISTS dulli_runs_thread_idx ON dulli_projection_runs(thread_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS dulli_projection_transcript (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS dulli_transcript_run_idx ON dulli_projection_transcript(thread_id, run_id, ordinal)`;

  const candidates = yield* sql<{
    subagent_id: string;
    thread_id: string;
    native_id: string;
    payload_json: string;
  }>`
    SELECT subagent_id, thread_id, json_extract(payload_json, '$.nativeTaskRef.nativeId') AS native_id, payload_json
    FROM orchestration_v2_projection_subagents
    WHERE subagent_id GLOB 'dulli:subagent:*:*' AND driver = 'dulli'
      AND origin = 'provider_native' AND json_extract(payload_json, '$.nativeTaskRef.driver') = 'dulli'
      AND json_extract(payload_json, '$.nativeTaskRef.nativeId') IS NOT NULL`;
  for (const row of candidates) {
    if (
      row.subagent_id !==
      `dulli:subagent:${encodeURIComponent(row.thread_id)}:${encodeURIComponent(row.native_id)}`
    )
      continue;
    yield* sql`INSERT OR IGNORE INTO dulli_projection_runs(id, thread_id, native_run_id, payload_json)
      VALUES (${row.subagent_id}, ${row.thread_id}, ${row.native_id}, ${row.payload_json})`;
  }
  // REVIEW: upstream/non-fork installs have no Pi bridge records. Avoid three
  // full event-log scans (and JSON decoding) when there is nothing to isolate.
  if (!(yield* sql`SELECT 1 FROM dulli_projection_runs LIMIT 1`).length) return;

  yield* sql`INSERT OR IGNORE INTO dulli_projection_transcript(id, thread_id, run_id, ordinal, payload_json)
    SELECT turn_item_id, thread_id, node_id, ordinal, payload_json
    FROM orchestration_v2_projection_turn_items
    WHERE node_id IN (SELECT id FROM dulli_projection_runs)
      AND turn_item_id GLOB 'dulli:subagent:*:*'`;

  yield* sql`UPDATE orchestration_events SET event_type = 'dulli-run.updated'
    WHERE application_event_version = 2 AND event_type = 'subagent.updated'
      AND json_extract(payload_json, '$.id') IN (SELECT id FROM dulli_projection_runs)`;
  yield* sql`UPDATE orchestration_events SET event_type = 'dulli-transcript.updated'
    WHERE application_event_version = 2 AND event_type = 'turn-item.updated'
      AND json_extract(payload_json, '$.id') GLOB 'dulli:subagent:*:*'
      AND json_extract(payload_json, '$.nodeId') IN (SELECT id FROM dulli_projection_runs)`;
  // Node events carry no independent Pi data. Turn them into harmless Dulli
  // invalidations instead of deleting stream versions or leaving graph edges.
  yield* sql`UPDATE orchestration_events
    SET event_type = 'dulli-transcript.changed', payload_json = json_object('nodeId', json_extract(payload_json, '$.id'))
    WHERE application_event_version = 2 AND event_type = 'node.updated'
      AND (json_extract(payload_json, '$.id') IN (SELECT id FROM dulli_projection_runs)
        OR json_extract(payload_json, '$.id') IN (SELECT 'dulli:subagent-root:' || thread_id FROM dulli_projection_runs))`;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id IN (SELECT id FROM dulli_projection_transcript)`;
  yield* sql`DELETE FROM orchestration_v2_projection_nodes
    WHERE node_id IN (SELECT id FROM dulli_projection_runs)
      OR node_id IN (SELECT 'dulli:subagent-root:' || thread_id FROM dulli_projection_runs)`;
  yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id IN (SELECT id FROM dulli_projection_runs)`;
});
