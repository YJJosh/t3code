import {
  DulliBackgroundTerminalControlError,
  type DulliBackgroundTerminalControlInput,
  type DulliBackgroundTerminalEvent,
  type ThreadId,
  type ProviderSessionId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";

type Session = {
  readonly instanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
};
type Control = (
  input: DulliBackgroundTerminalControlInput,
) => Effect.Effect<void, DulliBackgroundTerminalControlError>;

/** Ephemeral live-session directory, deliberately independent of orchestration history.
 * Registration never opens or recovers a provider. Tokens prevent a replaced
 * session's finalizer from clearing its successor or publishing stale output. */
export class DulliBackgroundTerminals extends Context.Service<
  DulliBackgroundTerminals,
  {
    readonly register: (
      threadId: ThreadId,
      session: Session,
      control: Control,
    ) => Effect.Effect<symbol>;
    readonly unregister: (
      threadId: ThreadId,
      token: symbol,
      reset: DulliBackgroundTerminalEvent,
    ) => Effect.Effect<void>;
    readonly publish: (
      threadId: ThreadId,
      token: symbol,
      event: DulliBackgroundTerminalEvent,
    ) => Effect.Effect<void>;
    readonly control: Control;
    readonly streamEvents: (threadId: ThreadId) => Stream.Stream<DulliBackgroundTerminalEvent>;
  }
>()("t3/provider/dulli/DulliBackgroundTerminals") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = new Map<ThreadId, Session & { token: symbol; control: Control }>();
  // A suspended socket must not retain unbounded terminal output.
  const events = yield* PubSub.sliding<{ threadId: ThreadId; event: DulliBackgroundTerminalEvent }>(
    256,
  );
  return DulliBackgroundTerminals.of({
    register: (threadId, session, control) =>
      Effect.sync(() => {
        const token = Symbol();
        sessions.set(threadId, { ...session, token, control });
        return token;
      }),
    publish: (threadId, token, event) =>
      Effect.suspend(() =>
        sessions.get(threadId)?.token === token
          ? PubSub.publish(events, { threadId, event }).pipe(Effect.asVoid)
          : Effect.void,
      ),
    unregister: (threadId, token, event) =>
      Effect.suspend(() => {
        if (sessions.get(threadId)?.token !== token) return Effect.void;
        sessions.delete(threadId);
        return PubSub.publish(events, { threadId, event }).pipe(Effect.asVoid);
      }),
    control: (input) =>
      Effect.gen(function* () {
        const session = sessions.get(input.threadId);
        if (!session)
          return yield* new DulliBackgroundTerminalControlError({
            message: "No live Dulli session for this thread. Send a message first.",
          });
        // A switched provider can remain resident until its queued detach lands.
        // Resolve only the current binding; never open/recover a provider here.
        const current = yield* projections
          .getThreadProviderContext(input.threadId, session.instanceId)
          .pipe(
            Effect.mapError(
              () =>
                new DulliBackgroundTerminalControlError({
                  message: "The thread's live provider binding is unavailable.",
                }),
            ),
          );
        const active = current.providerThreads.find(
          (candidate) => candidate.id === current.thread.activeProviderThreadId,
        );
        if (
          current.thread.archivedAt !== null ||
          current.thread.modelSelection.instanceId !== session.instanceId ||
          active?.driver !== "dulli" ||
          active.providerSessionId !== session.providerSessionId ||
          sessions.get(input.threadId)?.token !== session.token
        ) {
          return yield* new DulliBackgroundTerminalControlError({
            message: "The Dulli session is no longer active for this thread.",
          });
        }
        return yield* session.control(input);
      }),
    streamEvents: (threadId) =>
      Stream.fromPubSub(events).pipe(
        Stream.filter((entry) => entry.threadId === threadId),
        Stream.map((entry) => entry.event),
      ),
  });
});
export const layer = Layer.effect(DulliBackgroundTerminals, make);
