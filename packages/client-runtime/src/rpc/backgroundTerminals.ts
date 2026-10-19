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
 * Delay before requesting a replay after a connection is (re)established. The
 * event subscription and the replay control travel over the same socket; the
 * subscription is mounted first (its atom is read before this fires) so the
 * server has registered the per-thread listener before the snapshot is
 * pushed. The small delay makes that ordering robust against subscription
 * setup jitter.
 */
const REPLAY_REQUEST_DELAY = "150 millis";

/**
 * Live, reconnect-safe background-terminal runtime state for a thread.
 *
 * The stream folds the raw `subscribeBackgroundTerminalEvents` feed into the
 * pure projection from {@link applyBackgroundTerminalEvent}. In parallel it
 * watches the connection generation and, on every (re)connect, issues a
 * `replay` control so the server pushes a fresh snapshot onto the same event
 * feed. Because the outer scan state is retained across the subscription's
 * internal reconnects, a snapshot rebuilds the terminal set in place rather
 * than resetting it to empty on every reconnect.
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
