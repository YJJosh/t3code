import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../Migrations.ts";
import phaseMigration from "./001_ProjectionThreadMessagePhase.ts";
import migration from "./002_DulliProviderIdentity.ts";
import * as EventStore from "../../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as Maintenance from "../../../orchestration-v2/ProjectionMaintenance.ts";
import * as Importer from "../../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const importerLayer = Layer.mergeAll(Importer.layer, Maintenance.layer).pipe(
  Layer.provideMerge(sink),
);
const now = "2026-01-01T00:00:00.000Z";

const insertLegacyData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at)
    VALUES ('project','Project','/tmp/project','{"instanceId":"pi","model":"native/pi"}','[]',${now},${now})`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at)
    VALUES ('import:pi:uuid','project','pi stays in titles','{"instanceId":"pi","model":"native/pi","options":[{"id":"profile","value":"pi"}]}',${now},${now})`;
  yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at,resume_cursor_json,runtime_payload_json)
    VALUES ('import:pi:uuid','pi','pi','pi','stopped',${now},'{"piSessionId":"uuid","piSessionFile":"/native/pi/session.jsonl"}','{"modelSelection":{"instanceId":"pi","model":"native/pi"}}')`;
  yield* sql`INSERT INTO projection_thread_sessions (thread_id,status,provider_name,provider_instance_id,updated_at)
    VALUES ('import:pi:uuid','stopped','pi','pi',${now})`;
  yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at,phase)
    VALUES ('message','import:pi:uuid','assistant','Keep pi text',0,${now},${now},'commentary')`;
  yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
    VALUES ('legacy-event','thread','import:pi:uuid',1,'thread.session-set',${now},'provider','{"session":{"providerName":"pi","providerInstanceId":"pi"}}','{"adapterKey":"pi"}')`;
  yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
    VALUES ('tool-event','thread','import:pi:uuid',2,'thread.activity-appended',${now},'provider','{"activity":{"kind":"tool.completed","payload":{"driver":"pi","provider":"pi","text":"pi"}}}','{}')`;
});

for (const historicalId of [50, 55]) {
  it.layer(importerLayer)(`Dulli fork migration from ID ${historicalId}`, (it) => {
    it.effect("renames once, imports native continuity, and preserves native/user data", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: historicalId - 1 });
        yield* phaseMigration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (${historicalId},'ProjectionThreadMessagePhase')`;
        yield* insertLegacyData;
        yield* runMigrations();
        const importer = yield* Importer.LegacyV1ThreadImporter;
        yield* importer.reconcileShells;
        yield* importer.importPendingTranscripts;
        const runtime = (yield* sql<{
          provider_name: string;
          adapter_key: string;
          resume_cursor_json: string;
        }>`SELECT * FROM provider_session_runtime`)[0]!;
        assert.equal(runtime.provider_name, "dulli");
        assert.equal(runtime.adapter_key, "dulli");
        assert.deepStrictEqual(JSON.parse(runtime.resume_cursor_json), {
          piSessionId: "uuid",
          piSessionFile: "/native/pi/session.jsonl",
        });
        const thread = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_threads`)[0]!;
        const payload = JSON.parse(thread.payload_json);
        assert.equal(payload.id, "import:pi:uuid");
        assert.equal(payload.modelSelection.instanceId, "dulli");
        assert.equal(payload.modelSelection.options[0].value, "pi");
        assert.equal(payload.activeProviderThreadId, "migration:dulli:import:pi:uuid");
        const provider = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_provider_threads`)[0]!;
        assert.deepStrictEqual(JSON.parse(provider.payload_json).nativeThreadRef, {
          driver: "dulli",
          nativeId: "/native/pi/session.jsonl",
          strength: "strong",
        });
        const legacy = (yield* sql<{
          payload_json: string;
          metadata_json: string;
        }>`SELECT payload_json,metadata_json FROM orchestration_events WHERE event_id = 'legacy-event'`)[0]!;
        assert.equal(JSON.parse(legacy.payload_json).session.providerInstanceId, "dulli");
        assert.equal(JSON.parse(legacy.metadata_json).adapterKey, "dulli");
        const tool = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE event_id = 'tool-event'`)[0]!;
        assert.equal(JSON.parse(tool.payload_json).activity.payload.driver, "pi");
        assert.equal(
          (yield* sql<{ phase: string }>`SELECT phase FROM projection_thread_messages`)[0]!.phase,
          "commentary",
        );
        const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.equal(
          (yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_threads`)[0]!.payload_json,
          thread.payload_json,
        );
        const count = (yield* sql<{
          count: number;
        }>`SELECT count(*) count FROM orchestration_events`)[0]!.count;
        // Post-cutover upstream Pi remains Pi even if migration is invoked directly.
        yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at) VALUES ('upstream','pi','pi','pi','stopped',${now})`;
        yield* migration;
        yield* runMigrations();
        yield* importer.reconcileShells;
        assert.equal(
          (yield* sql<{ count: number }>`SELECT count(*) count FROM orchestration_events`)[0]!
            .count,
          count,
        );
        assert.equal(
          (yield* sql<{
            provider_name: string;
          }>`SELECT provider_name FROM provider_session_runtime WHERE thread_id = 'upstream'`)[0]!
            .provider_name,
          "pi",
        );
      }),
    );
  });
}

it.layer(database)("Dulli migration upstream isolation", (it) => {
  it.effect("does not infer a fork from this build's phase migration or upstream Pi data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* phaseMigration;
      yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at,resume_cursor_json)
      VALUES ('upstream','pi','pi','pi','stopped',${now},'{"sessionFile":"/native/pi/upstream.jsonl"}')`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT provider_name,provider_instance_id,adapter_key FROM provider_session_runtime`,
        [{ provider_name: "pi", provider_instance_id: "pi", adapter_key: "pi" }],
      );
      assert.lengthOf(
        yield* sql`SELECT * FROM dulli_fork_migrations WHERE name = 'fork-detected'`,
        0,
      );
    }),
  );
});

it.layer(importerLayer)("Dulli partially imported v2 fork", (it) => {
  it.effect("repairs already imported shells and preserves custom instance identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`CREATE TABLE dulli_fork_native_threads (thread_id TEXT PRIMARY KEY, provider_instance_id TEXT NOT NULL, session_file TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0)`;
      yield* phaseMigration;
      yield* insertLegacyData;
      // Reproduce the old upstream importer: a v2 shell exists but no native thread.
      const importer = yield* Importer.LegacyV1ThreadImporter;
      yield* importer.reconcileShells;
      assert.equal(
        (yield* sql<{
          active_provider_thread_id: string | null;
        }>`SELECT active_provider_thread_id FROM orchestration_v2_projection_threads`)[0]!
          .active_provider_thread_id,
        null,
      );
      const custom = JSON.stringify({
        driver: "pi",
        providerInstanceId: "work",
        nativeThreadRef: { driver: "pi", nativeId: "/native/pi/work.jsonl" },
        nativeMetadata: { modelSelection: { instanceId: "work", model: "provider/pi" } },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id,thread_id,provider,driver,provider_instance_id,status,updated_at,payload_json)
      VALUES ('custom','import:pi:uuid','work','pi','work','not_loaded',${now},${custom})`;
      yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES ('v2-custom','thread','import:pi:uuid',100,'provider-thread.updated',${now},'provider',${custom},'{"driver":"pi","providerInstanceId":"work"}',2)`;
      yield* sql`INSERT INTO pull_request_review_guides (host,repository,number,guide_json) VALUES ('github','repo',1,'{"modelSelection":{"instanceId":"pi","model":"native/pi"},"summary":"pi"}')`;
      yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
      VALUES ('task','pi','pi',0,'{}','project','{}','{"instanceId":"pi","model":"native/pi"}','full-access','default','user','client',${now},${now},'never',0)`;
      yield* runMigrations();
      yield* importer.reconcileShells;
      const provider = (yield* sql<{
        provider: string;
        driver: string;
        provider_instance_id: string;
        payload_json: string;
      }>`SELECT * FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = 'custom'`)[0]!;
      assert.equal(provider.provider, "work");
      assert.equal(provider.provider_instance_id, "work");
      assert.equal(provider.driver, "dulli");
      assert.equal(JSON.parse(provider.payload_json).nativeThreadRef.driver, "dulli");
      assert.equal(
        JSON.parse(provider.payload_json).nativeThreadRef.nativeId,
        "/native/pi/work.jsonl",
      );
      const event = (yield* sql<{
        payload_json: string;
        metadata_json: string;
      }>`SELECT payload_json,metadata_json FROM orchestration_events WHERE event_id = 'v2-custom'`)[0]!;
      assert.equal(JSON.parse(event.payload_json).driver, "dulli");
      assert.deepStrictEqual(JSON.parse(event.metadata_json), {
        driver: "dulli",
        providerInstanceId: "work",
      });
      assert.equal(
        (yield* sql<{
          active_provider_thread_id: string;
        }>`SELECT active_provider_thread_id FROM orchestration_v2_projection_threads`)[0]!
          .active_provider_thread_id,
        "migration:dulli:import:pi:uuid",
      );
      assert.equal(
        (yield* sql<{
          instance: string;
        }>`SELECT json_extract(guide_json,'$.modelSelection.instanceId') instance FROM pull_request_review_guides`)[0]!
          .instance,
        "dulli",
      );
      assert.equal(
        (yield* sql<{
          instance: string;
        }>`SELECT json_extract(model_selection_json,'$.instanceId') instance FROM scheduled_tasks`)[0]!
          .instance,
        "dulli",
      );
    }),
  );
});
