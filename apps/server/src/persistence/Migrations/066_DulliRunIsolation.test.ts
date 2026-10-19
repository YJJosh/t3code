import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../Sqlite.ts";
import migration from "./066_DulliRunIsolation.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-01-01T00:00:00.000Z";

it.effect(
  "moves exact Pi bridge identities once, preserves upstream byte-for-byte, and isolates replay",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const piId = "dulli:subagent:parent%2Fthread:child%2Frun";
      const ids = [
        piId,
        "codex-native-child",
        "dulli-app-delegation",
        "dulli:subagent:wrong:identity",
      ];
      for (const [index, id] of ids.entries()) {
        const driver = index === 1 ? "codex" : "dulli";
        const origin = index === 2 ? "app_owned" : "provider_native";
        const payload = json({
          id,
          threadId: "parent/thread",
          nativeTaskRef: { driver, nativeId: "child/run" },
          driver,
          origin,
        });
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, parent_node_id, provider, driver, origin, status, updated_at, payload_json)
        VALUES (${id}, 'parent/thread', 'root', ${driver}, ${driver}, ${origin}, 'running', ${at}, ${payload})`;
        yield* sql`INSERT INTO orchestration_events
        (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
        VALUES (${`run-${index}`},'thread','parent/thread',${index},'subagent.updated',${at},'provider',${payload},'{}',2)`;
      }
      const transcript = json({
        id: `${piId}:transcript:0`,
        nodeId: piId,
        text: "Retained answer",
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id,thread_id,node_id,ordinal,type,status,updated_at,payload_json)
      VALUES (${`${piId}:transcript:0`},'parent/thread',${piId},7,'assistant_message','completed',${at},${transcript})`;
      yield* sql`INSERT INTO orchestration_events
      (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('transcript','thread','parent/thread',4,'turn-item.updated',${at},'provider',${transcript},'{}',2)`;
      for (const [index, id] of [
        piId,
        "dulli:subagent-root:parent/thread",
        "codex-node",
      ].entries()) {
        const payload = json({ id });
        yield* sql`INSERT INTO orchestration_v2_projection_nodes(node_id,thread_id,root_node_id,kind,status,payload_json)
        VALUES (${id},'parent/thread','root','subagent','running',${payload})`;
        yield* sql`INSERT INTO orchestration_events
        (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
        VALUES (${`node-${index}`},'thread','parent/thread',${index + 5},'node.updated',${at},'provider',${payload},'{}',2)`;
      }
      const upstream =
        yield* sql`SELECT * FROM orchestration_v2_projection_subagents WHERE subagent_id <> ${piId} ORDER BY subagent_id`;
      const eventPositions =
        yield* sql`SELECT sequence, stream_version, event_id FROM orchestration_events ORDER BY sequence`;
      yield* sql.withTransaction(migration);
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_projection_subagents ORDER BY subagent_id`,
        upstream,
      );
      assert.deepEqual(yield* sql`SELECT id,native_run_id FROM dulli_projection_runs`, [
        { id: piId, native_run_id: "child/run" },
      ]);
      assert.deepEqual(yield* sql`SELECT payload_json FROM dulli_projection_transcript`, [
        { payload_json: transcript },
      ]);
      assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_projection_turn_items`, 0);
      assert.deepEqual(yield* sql`SELECT node_id FROM orchestration_v2_projection_nodes`, [
        { node_id: "codex-node" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT sequence, stream_version, event_id FROM orchestration_events ORDER BY sequence`,
        eventPositions,
      );
      assert.deepEqual(
        yield* sql`SELECT event_type FROM orchestration_events WHERE event_id IN ('run-0','transcript','node-0','node-1') ORDER BY sequence`,
        [
          { event_type: "dulli-run.updated" },
          { event_type: "dulli-transcript.updated" },
          { event_type: "dulli-transcript.changed" },
          { event_type: "dulli-transcript.changed" },
        ],
      );
      const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      yield* sql.withTransaction(migration);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`, before);
      assert.lengthOf(yield* sql`SELECT * FROM dulli_projection_runs`, 1);
      assert.lengthOf(yield* sql`SELECT * FROM dulli_projection_transcript`, 1);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

// REVIEW: the no-Pi fast path still installs the schema without rewriting an
// upstream-only event history or native subagent, including on a retry.
it.effect("upstream-only installs create empty Dulli tables and preserve native history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = json({ id: "native-agent", driver: "codex", origin: "provider_native" });
    yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, parent_node_id, provider, driver, origin, status, updated_at, payload_json)
      VALUES ('native-agent', 'thread', 'root', 'codex', 'codex', 'provider_native', 'running', ${at}, ${payload})`;
    yield* sql`INSERT INTO orchestration_events
      (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('native-event','thread','thread',1,'subagent.updated',${at},'provider',${payload},'{}',2)`;
    const before = yield* sql`SELECT * FROM orchestration_events`;
    const agents = yield* sql`SELECT * FROM orchestration_v2_projection_subagents`;
    yield* sql.withTransaction(migration);
    yield* sql.withTransaction(migration);
    assert.deepEqual(yield* sql`SELECT * FROM orchestration_events`, before);
    assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_projection_subagents`, agents);
    assert.lengthOf(yield* sql`SELECT * FROM dulli_projection_runs`, 0);
    assert.lengthOf(yield* sql`SELECT * FROM dulli_projection_transcript`, 0);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
