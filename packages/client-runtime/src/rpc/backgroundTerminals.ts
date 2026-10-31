import {
  type ThreadId,
  type EnvironmentId,
  type EnvironmentAuthorizationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  applyBackgroundTerminalEvent,
  EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
} from "../state/backgroundTerminalRuntime.ts";
import { RpcPermissionGuard, requestGuarded, subscribe } from "./client.ts";

/**
 * Mount the event subscription before requesting replay on the same socket,
 * so the server registers its per-thread listener before pushing the snapshot.
 * Delay replay to tolerate subscription setup jitter.
 */
const REPLAY_REQUEST_DELAY = "150 millis";

/**
 * Keep the fold across subscription reconnects; replay on each connection generation
 * rebuilds terminals in place from an authoritative snapshot, avoiding an empty flash.
 */
export function backgroundTerminalRuntimeChanges(
  threadId: ThreadId,
  authorize: (
    environmentId: EnvironmentId,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>,
) {
  const events = subscribe(WS_METHODS.subscribeBackgroundTerminalEvents, { threadId });

  const replayOnConnect = Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        Stream.concat(
          Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
          SubscriptionRef.changes(supervisor.state),
        ).pipe(
          Stream.filterMap((state) =>
            state.phase === "connected" ? Result.succeed(state.generation) : Result.failVoid,
          ),
          Stream.changes,
          Stream.mapEffect(() =>
            Effect.sleep(REPLAY_REQUEST_DELAY).pipe(
              Effect.andThen(
                requestGuarded(WS_METHODS.backgroundTerminalsControl, {
                  threadId,
                  action: "replay",
                }),
              ),
              // A provider that cannot serve background terminals (or a
              // transient failure) simply yields no snapshot; the stream
              // stays empty and no rows render. Never surface this on the
              // value channel.
              Effect.ignore,
            ),
          ),
          Stream.drain,
        ),
      ),
    ),
  );

  return Stream.merge(events, replayOnConnect).pipe(
    Stream.scanEffect(
      () => EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE,
      (state, event) => {
        const next = applyBackgroundTerminalEvent(state, event);
        if (!state.needsReconciliation && next.needsReconciliation) {
          return requestGuarded(WS_METHODS.backgroundTerminalsControl, {
            threadId,
            action: "replay",
          }).pipe(Effect.ignore, Effect.as(next));
        }
        return Effect.succeed(next);
      },
    ),
    Stream.provideService(RpcPermissionGuard, { authorize }),
  );
}
