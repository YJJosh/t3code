import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function hasForkPiSettings(value: unknown): boolean {
  const settings = jsonObject(value);
  const legacy = jsonObject(jsonObject(settings?.providers)?.pi);
  const configs = [
    legacy,
    ...Object.values(jsonObject(settings?.providerInstances) ?? {}).flatMap((value) => {
      const instance = jsonObject(value);
      return instance?.driver === "pi" ? [jsonObject(instance.config)] : [];
    }),
  ];
  return configs.some(
    (config) =>
      config &&
      ["profile", "agentDir", "piSessions", "shareWithTerminal"].some((key) => key in config),
  );
}

/** Capture evidence BEFORE reconciliation removes the historical fork ledger rows.
 * Never use the phase column or migration 63: this build adds those on upstream installs too.
 * The checked marker freezes the decision, so future upstream Pi data cannot trigger a rename.
 */
export const detectDulliFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS dulli_fork_migrations (name TEXT PRIMARY KEY)`;
  if ((yield* sql`SELECT name FROM dulli_fork_migrations WHERE name = 'database-checked'`).length)
    return;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  const names = new Set(tables.map((row) => row.name));
  const ledger = names.has("effect_sql_migrations")
    ? yield* sql`SELECT 1 FROM effect_sql_migrations WHERE migration_id IN (50, 55) AND name = 'ProjectionThreadMessagePhase' LIMIT 1`
    : [];
  const cursors = names.has("provider_session_runtime")
    ? yield* sql`SELECT 1 FROM provider_session_runtime WHERE provider_name = 'pi' AND json_valid(resume_cursor_json) AND json_type(resume_cursor_json, '$.piSessionFile') = 'text' LIMIT 1`
    : [];
  if (ledger.length || cursors.length) {
    yield* sql`INSERT OR IGNORE INTO dulli_fork_migrations VALUES ('fork-detected')`;
  }
});

// Paths are schema-owned identities, never arbitrary tool output, model provider names,
// message text, native IDs, or session filenames. The wildcard visits typed arrays only.
export function renamePiPaths(value: unknown, paths: ReadonlyArray<string>): unknown {
  const visit = (current: unknown, parts: string[]): void => {
    const [key, ...rest] = parts;
    if (key === undefined) return;
    if (key === "*") {
      if (Array.isArray(current))
        for (let index = 0; index < current.length; index++) {
          if (rest.length) visit(current[index], rest);
          else if (current[index] === "pi") current[index] = "dulli";
        }
      return;
    }
    const object = jsonObject(current);
    if (!object) return;
    if (rest.length) visit(object[key], rest);
    else if (object[key] === "pi") object[key] = "dulli";
  };
  for (const path of paths) visit(value, path.split("."));
  return value;
}

const selectionPaths = (prefix: string) => [`${prefix}instanceId`, `${prefix}provider`];
const recordPaths = [
  "driver",
  "providerInstanceId",
  ...selectionPaths("modelSelection."),
  ...selectionPaths("defaultModelSelection."),
  ...[
    "nativeThreadRef",
    "nativeConversationHeadRef",
    "nativeTurnRef",
    "nativeItemRef",
    "nativeRequestRef",
    "nativeTaskRef",
  ].map((key) => `${key}.driver`),
  ...selectionPaths("nativeMetadata.modelSelection."),
  "sourceProviderInstanceId",
  "targetProviderInstanceId",
  "sourcePoint.providerThreadRef.driver",
  "sourcePoint.providerTurnRef.driver",
  "basePoint.providerThreadRef.driver",
  "basePoint.providerTurnRef.driver",
  "resolution.providerThreadRef.driver",
];
const turnItemPaths = [
  ...recordPaths,
  "fromProviderInstanceIds.*",
  "toProviderInstanceId",
  ...selectionPaths("fromModelSelections.*."),
];
// V1 events have small, explicit payload shapes; activity payloads are intentionally
// not traversed as generic objects (they contain native model providers and tool JSON).
const v1EventPaths: Record<string, string[]> = {
  "project.created": selectionPaths("defaultModelSelection."),
  "project.meta-updated": selectionPaths("defaultModelSelection."),
  "thread.created": selectionPaths("modelSelection."),
  "thread.meta-updated": selectionPaths("modelSelection."),
  "thread.turn-start-requested": selectionPaths("modelSelection."),
  "thread.session-set": ["session.providerName", "session.providerInstanceId"],
};
const v2IdentityEvents = new Set([
  "project.created",
  "project.metadata-updated",
  "project.meta-updated",
  "thread.created",
  "thread.metadata-updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.auto-settle-set",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.visited",
  "thread.marked-unread",
  "thread.pull-request-synced",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "run.created",
  "run.updated",
  "run-attempt.created",
  "run-attempt.updated",
  "node.updated",
  "subagent.updated",
  "provider-session.attached",
  "provider-session.updated",
  "provider-thread.updated",
  "provider-turn.updated",
  "runtime-request.updated",
  "turn-item.updated",
  "context-transfer.created",
  "context-transfer.updated",
  "context-handoff.updated",
]);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* detectDulliFork;
  yield* sql`CREATE TABLE IF NOT EXISTS dulli_fork_native_threads (
    thread_id TEXT PRIMARY KEY,
    provider_instance_id TEXT NOT NULL,
    session_file TEXT NOT NULL,
    imported INTEGER NOT NULL DEFAULT 0
  )`;
  if ((yield* sql`SELECT name FROM dulli_fork_migrations WHERE name = 'database-checked'`).length)
    return;
  if (!(yield* sql`SELECT name FROM dulli_fork_migrations WHERE name = 'fork-detected'`).length) {
    yield* sql`INSERT INTO dulli_fork_migrations VALUES ('database-checked')`;
    return;
  }

  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  const names = new Set(tables.map((row) => row.name));
  // Bound each read even on multi-gigabyte fork logs. JSON is parsed only for rows
  // containing the exact old token; updates preserve every unrelated field.
  const rewrite = Effect.fn("DulliProviderIdentity.rewrite")(function* (
    table: string,
    column: string,
    paths: ReadonlyArray<string>,
    eventLog = false,
  ) {
    if (!names.has(table)) return;
    // review guides are WITHOUT ROWID, and use a composite key.
    if (table === "pull_request_review_guides") {
      const rows = yield* sql<{
        host: string;
        repository: string;
        number: number;
        guide_json: string;
      }>`SELECT * FROM pull_request_review_guides`;
      for (const row of rows) {
        const parsed = yield* decodeJson(row.guide_json);
        const next = yield* encodeJson(renamePiPaths(parsed, paths));
        if (next !== row.guide_json)
          yield* sql`UPDATE pull_request_review_guides SET guide_json = ${next} WHERE host = ${row.host} AND repository = ${row.repository} AND number = ${row.number}`;
      }
      return;
    }
    let after = 0;
    while (true) {
      const rows = yield* sql.unsafe<{
        rid: number;
        value: string;
        event_type?: string;
        application_event_version?: number;
      }>(
        `SELECT rowid AS rid, ${column} AS value${eventLog ? ", event_type, application_event_version" : ""} FROM ${table} WHERE rowid > ? AND instr(${column}, '"pi"') > 0 ORDER BY rowid LIMIT 100`,
        [after],
      );
      if (!rows.length) break;
      for (const row of rows) {
        const selected =
          eventLog && column === "payload_json"
            ? row.application_event_version === 2
              ? v2IdentityEvents.has(row.event_type ?? "")
                ? turnItemPaths
                : []
              : (v1EventPaths[row.event_type ?? ""] ?? [])
            : paths;
        if (!selected.length) continue;
        const parsed = yield* decodeJson(row.value);
        const before = yield* encodeJson(parsed);
        const next = yield* encodeJson(renamePiPaths(parsed, selected));
        if (next !== before)
          yield* sql.unsafe(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, [next, row.rid]);
      }
      after = rows[rows.length - 1]!.rid;
    }
  });

  yield* sql`
    INSERT OR IGNORE INTO dulli_fork_native_threads (thread_id, provider_instance_id, session_file)
    SELECT thread_id, CASE WHEN provider_instance_id IS NULL OR provider_instance_id = 'pi' THEN 'dulli' ELSE provider_instance_id END,
      json_extract(resume_cursor_json, '$.piSessionFile')
    FROM provider_session_runtime
    WHERE provider_name = 'pi' AND json_valid(resume_cursor_json)
      AND json_type(resume_cursor_json, '$.piSessionFile') = 'text'
      AND length(trim(json_extract(resume_cursor_json, '$.piSessionFile'))) > 0
  `;
  const missingNativeFiles = yield* sql<{ count: number }>`
    SELECT count(*) AS count FROM provider_session_runtime AS runtime
    WHERE provider_name = 'pi' AND NOT EXISTS (
      SELECT 1 FROM dulli_fork_native_threads AS native WHERE native.thread_id = runtime.thread_id
    )
  `;
  if ((missingNativeFiles[0]?.count ?? 0) > 0) {
    yield* Effect.logWarning(
      "Some legacy Dulli sessions have no saved Pi session file. Their conversation history and cursors are preserved, but native resume cannot be restored automatically.",
      { count: missingNativeFiles[0]!.count },
    );
  }
  for (const table of ["projection_threads", "scheduled_tasks"])
    yield* rewrite(table, "model_selection_json", selectionPaths(""));
  yield* rewrite("projection_projects", "default_model_selection_json", selectionPaths(""));
  yield* rewrite("pull_request_review_guides", "guide_json", selectionPaths("modelSelection."));
  for (const table of ["projection_thread_sessions", "provider_session_runtime"]) {
    yield* sql.unsafe(
      `UPDATE ${table} SET provider_instance_id = COALESCE(provider_instance_id, 'dulli'), provider_name = 'dulli' WHERE provider_name = 'pi'`,
    );
    yield* sql.unsafe(
      `UPDATE ${table} SET provider_instance_id = 'dulli' WHERE provider_instance_id = 'pi'`,
    );
  }
  yield* sql`UPDATE provider_session_runtime SET adapter_key = 'dulli' WHERE adapter_key = 'pi'`;
  yield* rewrite("provider_session_runtime", "runtime_payload_json", [
    ...recordPaths,
    "providerName",
    "importedTranscripts.*.provider",
    "importedTranscripts.*.providerInstanceId",
  ]);
  yield* rewrite("orchestration_events", "payload_json", [], true);
  yield* rewrite("orchestration_events", "metadata_json", [
    "driver",
    "providerInstanceId",
    "adapterKey",
  ]);
  for (const table of names) {
    if (!(table.startsWith("orchestration_v2_projection_") || table === "orchestration_v2_events"))
      continue;
    const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);
    const columnNames = new Set(columns.map((column) => column.name));
    for (const column of [
      "driver",
      "provider_instance_id",
      "provider",
      "default_provider",
      "source_provider_instance_id",
      "target_provider_instance_id",
      "source_provider",
      "target_provider",
    ]) {
      if (columnNames.has(column))
        yield* sql.unsafe(`UPDATE ${table} SET ${column} = 'dulli' WHERE ${column} = 'pi'`);
    }
    if (columnNames.has("payload_json")) yield* rewrite(table, "payload_json", turnItemPaths);
  }
  // Current EffectOutbox's discriminated requests contain only opaque run/thread/
  // session IDs and user answers, not model selections or driver identities. Do not
  // traverse them: a user answer named "provider" is not routing configuration.
  yield* sql`INSERT INTO dulli_fork_migrations VALUES ('database-checked')`;
  yield* Effect.log(
    "Migrated fork Pi routing identities to Dulli; native Pi cursors and IDs were preserved.",
  );
});
