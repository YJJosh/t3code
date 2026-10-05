import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const Link = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sessionId: Schema.String,
});
type Link = typeof Link.Type;
const Baseline = Schema.Struct({
  daemonRev: Schema.Finite,
  daemonSettled: Schema.Boolean,
  t3Settled: Schema.Boolean,
});
type Baseline = typeof Baseline.Type;

export class PiSessionsSettlementError extends Schema.TaggedError<PiSessionsSettlementError>()(
  "PiSessionsSettlementError",
  { operation: Schema.Literals(["get", "set"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Pi session settlement baseline ${this.operation} failed.`;
  }
}

/** Sync bookkeeping is separate from provider runtime rows: binding replacement,
 * stopping a provider, and transcript-marker writes must never reset a baseline. */
export class PiSessionsSettlement extends Context.Service<
  PiSessionsSettlement,
  {
    readonly get: (link: Link) => Effect.Effect<Option.Option<Baseline>, PiSessionsSettlementError>;
    readonly set: (
      link: Link,
      baseline: Baseline,
    ) => Effect.Effect<void, PiSessionsSettlementError>;
  }
>()("t3/persistence/PiSessionsSettlement") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Created here rather than in Migrations.ts: the migrator skips every ID at or
  // below the newest applied one, so a fork-only migration ID hides upstream's
  // migration with the same ID (see forgetLegacyForkMigration50).
  yield* sql`
    CREATE TABLE IF NOT EXISTS pi_sessions_settlement (
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      baseline_json TEXT NOT NULL,
      PRIMARY KEY (environment_id, thread_id, session_id)
    ) WITHOUT ROWID
  `;
  const get = SqlSchema.findOneOption({
    Request: Link,
    Result: Schema.Struct({ baseline: Schema.fromJsonString(Baseline) }),
    execute: (link) => sql`
      SELECT baseline_json AS baseline FROM pi_sessions_settlement
      WHERE environment_id = ${link.environmentId} AND thread_id = ${link.threadId}
        AND session_id = ${link.sessionId}
    `,
  });
  const set = SqlSchema.void({
    Request: Schema.Struct({ ...Link.fields, baseline: Schema.fromJsonString(Baseline) }),
    execute: (input) => sql`
      INSERT INTO pi_sessions_settlement (environment_id, thread_id, session_id, baseline_json)
      VALUES (${input.environmentId}, ${input.threadId}, ${input.sessionId}, ${input.baseline})
      ON CONFLICT (environment_id, thread_id, session_id)
      DO UPDATE SET baseline_json = excluded.baseline_json
    `,
  });
  return PiSessionsSettlement.of({
    get: (link) =>
      get(link).pipe(
        Effect.map(Option.map((row) => row.baseline)),
        Effect.mapError((cause) => new PiSessionsSettlementError({ operation: "get", cause })),
      ),
    set: (link, baseline) =>
      set({ ...link, baseline }).pipe(
        Effect.mapError((cause) => new PiSessionsSettlementError({ operation: "set", cause })),
      ),
  });
});

export const layer = Layer.effect(PiSessionsSettlement, make);
