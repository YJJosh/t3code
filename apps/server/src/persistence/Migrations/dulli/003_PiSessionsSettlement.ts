import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Preserve the fork table and its durable reconciliation baselines verbatim. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pi_sessions_settlement (
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    baseline_json TEXT NOT NULL,
    PRIMARY KEY (environment_id, thread_id, session_id)
  ) WITHOUT ROWID`;
});
