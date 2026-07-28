import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import { and, eq, ne, or, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";

export const MANAGED_ENDPOINT_PROVISIONING_LEASE = "5 minutes";

export type ManagedEndpointAllocationState =
  | "provisioning"
  | "ready"
  | "releasing"
  | "deprovisioning"
  | "offline";

export interface ManagedEndpointAllocation {
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string;
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  readonly state: ManagedEndpointAllocationState;
  /** Monotonic compare-and-swap token for destructive allocation operations. */
  readonly generation: number;
  readonly updatedAt: string;
}

export function resolveReadyManagedEndpoint(input: {
  readonly allocation: ManagedEndpointAllocation;
  readonly baseDomain: string | undefined;
}): RelayManagedEndpoint | null {
  if (
    !input.baseDomain ||
    input.allocation.readyAt === null ||
    input.allocation.tunnelId === null ||
    input.allocation.dnsRecordId === null ||
    !isManagedEndpointHostname(input.allocation.hostname, input.baseDomain)
  ) {
    return null;
  }
  return managedEndpointForHostname(input.allocation.hostname);
}

export class ManagedEndpointAllocationPersistenceError extends Schema.TaggedErrorClass<ManagedEndpointAllocationPersistenceError>()(
  "ManagedEndpointAllocationPersistenceError",
  {
    operation: Schema.Literals([
      "get",
      "reserve",
      "record-tunnel",
      "record-dns",
      "mark-ready",
      "claim-release",
      "complete-release",
      "claim-deprovision",
      "remove",
      "remove-claimed",
    ]),
    stage: Schema.Literals(["database-request", "resolve-reservation"]),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint allocation '${this.operation}' failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

interface ManagedEndpointAllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

interface ReserveManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly hostname: string;
  readonly tunnelName: string;
}

interface RecordManagedEndpointTunnelInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
}

interface RecordManagedEndpointDnsInput extends ManagedEndpointAllocationKey {
  readonly dnsRecordId: string;
  readonly generation: number;
}

interface MarkManagedEndpointReadyInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

interface ClaimManagedEndpointReleaseInput extends ManagedEndpointAllocationKey {
  readonly tunnelId: string;
  readonly generation: number;
}

interface CompleteManagedEndpointReleaseInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

interface ClaimManagedEndpointDeprovisionInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

interface RemoveClaimedManagedEndpointAllocationInput extends ManagedEndpointAllocationKey {
  readonly generation: number;
}

export class ManagedEndpointAllocations extends Context.Service<
  ManagedEndpointAllocations,
  {
    readonly get: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    readonly reserve: (
      input: ReserveManagedEndpointAllocationInput,
    ) => Effect.Effect<ManagedEndpointAllocation, ManagedEndpointAllocationPersistenceError>;
    readonly recordTunnel: (
      input: RecordManagedEndpointTunnelInput,
    ) => Effect.Effect<number, ManagedEndpointAllocationPersistenceError>;
    readonly recordDns: (
      input: RecordManagedEndpointDnsInput,
    ) => Effect.Effect<number, ManagedEndpointAllocationPersistenceError>;
    readonly markReady: (
      input: MarkManagedEndpointReadyInput,
    ) => Effect.Effect<number, ManagedEndpointAllocationPersistenceError>;
    /**
     * Atomically claims the right to delete the allocation's tunnel: succeeds
     * only while the recorded tunnel and generation still match what the
     * caller loaded. The releasing state blocks a new provision from reusing
     * the tunnel until destructive cleanup has completed.
     *
     * Returns the new claim generation, or null when another allocation
     * mutation superseded the caller's snapshot.
     */
    readonly claimRelease: (
      input: ClaimManagedEndpointReleaseInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly completeRelease: (
      input: CompleteManagedEndpointReleaseInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
    /**
     * Claims the complete allocation for teardown only if its generation still
     * matches the snapshot captured by the unlink operation.
     *
     * Returns the claim generation used by `removeClaimed`, or null when a
     * concurrent provision has already superseded the snapshot.
     */
    readonly claimDeprovision: (
      input: ClaimManagedEndpointDeprovisionInput,
    ) => Effect.Effect<number | null, ManagedEndpointAllocationPersistenceError>;
    readonly remove: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<void, ManagedEndpointAllocationPersistenceError>;
    readonly removeClaimed: (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) => Effect.Effect<boolean, ManagedEndpointAllocationPersistenceError>;
  }
>()("t3code-relay/environments/ManagedEndpointAllocations") {}

const allocationSelection = {
  userId: relayManagedEndpointAllocations.userId,
  environmentId: relayManagedEndpointAllocations.environmentId,
  hostname: relayManagedEndpointAllocations.hostname,
  tunnelId: relayManagedEndpointAllocations.tunnelId,
  tunnelName: relayManagedEndpointAllocations.tunnelName,
  dnsRecordId: relayManagedEndpointAllocations.dnsRecordId,
  readyAt: relayManagedEndpointAllocations.readyAt,
  state: relayManagedEndpointAllocations.state,
  generation: relayManagedEndpointAllocations.generation,
  updatedAt: relayManagedEndpointAllocations.updatedAt,
};

const whereAllocation = (input: ManagedEndpointAllocationKey) =>
  and(
    eq(relayManagedEndpointAllocations.userId, input.userId),
    eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
  );

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const resolveMutationGeneration = (
    operation: "record-tunnel" | "record-dns" | "mark-ready",
    input: ManagedEndpointAllocationKey,
    rows: ReadonlyArray<{ readonly generation: number }>,
  ) => {
    const generation = rows[0]?.generation;
    return generation === undefined
      ? Effect.fail(
          new ManagedEndpointAllocationPersistenceError({
            operation,
            stage: "resolve-reservation",
            ...input,
          }),
        )
      : Effect.succeed(generation);
  };

  return ManagedEndpointAllocations.of({
    get: Effect.fn("relay.managed_endpoint_allocations.get")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    reserve: Effect.fn("relay.managed_endpoint_allocations.reserve")(function* (
      input: ReserveManagedEndpointAllocationInput,
    ) {
      const currentTime = yield* DateTime.now;
      const now = DateTime.formatIso(currentTime);
      const reservationCutoff = DateTime.formatIso(
        DateTime.subtractDuration(currentTime, MANAGED_ENDPOINT_PROVISIONING_LEASE),
      );
      const inserted = yield* db
        .insert(relayManagedEndpointAllocations)
        .values({
          ...input,
          state: "provisioning",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            relayManagedEndpointAllocations.userId,
            relayManagedEndpointAllocations.environmentId,
          ],
          set: {
            hostname: input.hostname,
            tunnelName: input.tunnelName,
            state: "provisioning",
            generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
            updatedAt: now,
          },
          setWhere: sql`(
            ${relayManagedEndpointAllocations.state} IN ('ready', 'offline')
            OR (
              ${relayManagedEndpointAllocations.state} = 'provisioning'
              AND ${relayManagedEndpointAllocations.updatedAt} < ${reservationCutoff}
            )
          )`,
        })
        .returning(allocationSelection)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "reserve",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );

      const reservation = inserted[0];
      if (reservation !== undefined) {
        return reservation;
      }

      // Resolve the row once for persistence diagnostics, but never reuse it:
      // a zero-row upsert means another live provision or destructive cleanup
      // owns this environment. The caller retries after that lease completes.
      yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "reserve",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
      return yield* new ManagedEndpointAllocationPersistenceError({
        operation: "reserve",
        stage: "resolve-reservation",
        ...input,
      });
    }),
    recordTunnel: Effect.fn("relay.managed_endpoint_allocations.record_tunnel")(function* (
      input: RecordManagedEndpointTunnelInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          tunnelId: input.tunnelId,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.state, "provisioning"),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-tunnel",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
          Effect.flatMap((rows) => resolveMutationGeneration("record-tunnel", input, rows)),
        );
    }),
    recordDns: Effect.fn("relay.managed_endpoint_allocations.record_dns")(function* (
      input: RecordManagedEndpointDnsInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          dnsRecordId: input.dnsRecordId,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.state, "provisioning"),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-dns",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
          Effect.flatMap((rows) => resolveMutationGeneration("record-dns", input, rows)),
        );
    }),
    markReady: Effect.fn("relay.managed_endpoint_allocations.mark_ready")(function* (
      input: MarkManagedEndpointReadyInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          readyAt: now,
          state: "ready",
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.state, "provisioning"),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "mark-ready",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
          Effect.flatMap((rows) => resolveMutationGeneration("mark-ready", input, rows)),
        );
    }),
    claimRelease: Effect.fn("relay.managed_endpoint_allocations.claim_release")(function* (
      input: ClaimManagedEndpointReleaseInput,
    ) {
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          state: "releasing",
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
            or(
              eq(relayManagedEndpointAllocations.state, "ready"),
              eq(relayManagedEndpointAllocations.state, "releasing"),
            ),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-release",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId: input.tunnelId,
                cause,
              }),
          ),
        );
      return claimed;
    }),
    completeRelease: Effect.fn("relay.managed_endpoint_allocations.complete_release")(function* (
      input: CompleteManagedEndpointReleaseInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          state: "offline",
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.state, "releasing"),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ userId: relayManagedEndpointAllocations.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "complete-release",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
    claimDeprovision: Effect.fn("relay.managed_endpoint_allocations.claim_deprovision")(function* (
      input: ClaimManagedEndpointDeprovisionInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          state: "deprovisioning",
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
            ne(relayManagedEndpointAllocations.state, "provisioning"),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-deprovision",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
    remove: Effect.fn("relay.managed_endpoint_allocations.remove")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      yield* db
        .delete(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "remove",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    removeClaimed: Effect.fn("relay.managed_endpoint_allocations.remove_claimed")(function* (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) {
      return yield* db
        .delete(relayManagedEndpointAllocations)
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ userId: relayManagedEndpointAllocations.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "remove-claimed",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointAllocations, make);
