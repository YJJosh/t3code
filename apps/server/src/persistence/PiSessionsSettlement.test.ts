import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "./Migrations/dulli/003_PiSessionsSettlement.ts";
import * as PiSessionsSettlement from "./PiSessionsSettlement.ts";

it.layer(NodeServices.layer)("PiSessionsSettlement", (it) => {
  it.effect(
    "preserves fork rows through migration, restart and unrelated runtime replacement",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const persistence = NodeSqliteClient.layer({ filename: `${root}/state.sqlite` });
        const layer = PiSessionsSettlement.layer.pipe(Layer.provide(persistence));
        const link = {
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("import:pi:session"),
          sessionId: "session",
        };
        const baseline = { daemonRev: 7, daemonSettled: true, t3Settled: true };
        yield* Effect.gen(function* () {
          yield* migration;
          const store = yield* PiSessionsSettlement.PiSessionsSettlement.pipe(
            Effect.provide(PiSessionsSettlement.layer),
          );
          yield* store.set(link, baseline);
          yield* migration;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE provider_session_runtime (thread_id TEXT)`;
          yield* sql`INSERT INTO provider_session_runtime VALUES ('import:pi:session')`;
          yield* sql`DELETE FROM provider_session_runtime`;
        }).pipe(Effect.provide(persistence));
        yield* Effect.gen(function* () {
          const store = yield* PiSessionsSettlement.PiSessionsSettlement;
          expect(Option.getOrThrow(yield* store.get(link))).toEqual(baseline);
          for (const other of [
            { ...link, environmentId: EnvironmentId.make("other") },
            { ...link, threadId: ThreadId.make("other") },
            { ...link, sessionId: "other" },
          ])
            expect(Option.isNone(yield* store.get(other))).toBe(true);
        }).pipe(Effect.provide(Layer.fresh(layer)));
      }).pipe(Effect.scoped),
  );
});
