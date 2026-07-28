import { and, count, eq, gt, ne, or } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { isSqlError } from "effect/unstable/sql/SqlError";

import * as RelayDb from "../db.ts";
import {
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";

/**
 * Managed tunnels a user may hold at once unless a row in
 * `relay_managed_tunnel_limits` overrides it for that user.
 */
export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;
const CAPACITY_RESERVATION_TTL = "5 minutes";

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedErrorClass<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["load-limit", "count-tunnels", "reserve-capacity"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedErrorClass<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    readonly ensureCapacity: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError>;
    readonly reserveCapacity: <A, E, R>(
      input: {
        readonly userId: string;
        readonly environmentId: string;
      },
      reservation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError, R>;
  }
>()("t3code-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const ensureCapacity: ManagedTunnelLimits["Service"]["ensureCapacity"] = Effect.fn(
    "relay.managed_tunnel_limits.ensure_capacity",
  )(function* (input) {
    const overrides = yield* db
      .select({ maxTunnels: relayManagedTunnelLimits.maxTunnels })
      .from(relayManagedTunnelLimits)
      .where(eq(relayManagedTunnelLimits.userId, input.userId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ManagedTunnelLimitPersistenceError({
              operation: "load-limit",
              userId: input.userId,
              cause,
            }),
        ),
      );
    const maxTunnels = overrides[0]?.maxTunnels ?? DEFAULT_MANAGED_TUNNEL_LIMIT;

    const reservationCutoff = DateTime.formatIso(
      DateTime.subtractDuration(yield* DateTime.now, CAPACITY_RESERVATION_TTL),
    );
    // Ready allocations count while their tunnel is live. Releasing and
    // deprovisioning allocations count until destructive cleanup commits.
    // Provisioning reservations expire if a Worker dies mid-request.
    // The current environment remains idempotent at the limit.
    const counted = yield* db
      .select({ activeTunnels: count() })
      .from(relayManagedEndpointAllocations)
      .where(
        and(
          eq(relayManagedEndpointAllocations.userId, input.userId),
          ne(relayManagedEndpointAllocations.environmentId, input.environmentId),
          or(
            eq(relayManagedEndpointAllocations.state, "ready"),
            eq(relayManagedEndpointAllocations.state, "releasing"),
            eq(relayManagedEndpointAllocations.state, "deprovisioning"),
            and(
              eq(relayManagedEndpointAllocations.state, "provisioning"),
              gt(relayManagedEndpointAllocations.updatedAt, reservationCutoff),
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ManagedTunnelLimitPersistenceError({
              operation: "count-tunnels",
              userId: input.userId,
              cause,
            }),
        ),
      );
    const activeTunnels = counted[0]?.activeTunnels ?? 0;

    if (activeTunnels >= maxTunnels) {
      return yield* new ManagedTunnelLimitExceeded({
        userId: input.userId,
        environmentId: input.environmentId,
        maxTunnels,
        activeTunnels,
      });
    }
  });

  const reserveCapacity: ManagedTunnelLimits["Service"]["reserveCapacity"] = (input, reservation) =>
    db.$client
      .withTransaction(
        Effect.gen(function* () {
          // Serialize reservations for one user across Worker instances. The
          // lock and allocation insert share this transaction, so the next
          // waiter observes the committed reservation before checking quota.
          yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`;
          yield* ensureCapacity(input);
          return yield* reservation;
        }),
      )
      .pipe(
        Effect.catchIf(isSqlError, (cause) =>
          Effect.fail(
            new ManagedTunnelLimitPersistenceError({
              operation: "reserve-capacity",
              userId: input.userId,
              cause,
            }),
          ),
        ),
      );

  return ManagedTunnelLimits.of({
    ensureCapacity,
    reserveCapacity,
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
