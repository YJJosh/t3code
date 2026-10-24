import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** True while a fork database still has V1 task activity rows whose thread has
 * no imported Pi subagent history. Upstream migration 063 keeps
 * `projection_thread_activities` until this is false, and the fork's legacy
 * importer drops it then. */
export const hasPendingDulliSubagentHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('projection_thread_activities', 'dulli_fork_migrations')`;
  if (tables.length < 2) return false;
  const pending = yield* sql`SELECT 1 FROM projection_thread_activities a
    WHERE EXISTS (SELECT 1 FROM dulli_fork_migrations WHERE name = 'fork-detected')
      AND a.kind IN ('task.started', 'task.progress', 'task.updated', 'task.completed')
      AND NOT EXISTS (SELECT 1 FROM dulli_fork_migrations m
        WHERE m.name = 'subagent-history-v1:' || a.thread_id)
    LIMIT 1`;
  return pending.length > 0;
});
