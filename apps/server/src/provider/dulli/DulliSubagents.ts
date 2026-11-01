/** Active-session controls only: looking up a child never starts/revives a provider. */
import {
  ProviderTaskControlError,
  type ProviderTaskControlInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type Control = (input: ProviderTaskControlInput) => Effect.Effect<void, ProviderTaskControlError>;
export class DulliSubagents extends Context.Service<
  DulliSubagents,
  {
    readonly register: (threadId: ThreadId, control: Control) => Effect.Effect<symbol>;
    readonly unregister: (threadId: ThreadId, token: symbol) => Effect.Effect<void>;
    readonly control: Control;
  }
>()("t3/provider/dulli/DulliSubagents") {}

export const layer = Layer.effect(
  DulliSubagents,
  Effect.sync(() => {
    const sessions = new Map<ThreadId, { token: symbol; control: Control }>();
    return DulliSubagents.of({
      register: Effect.fn("DulliSubagents.register")((threadId, control) =>
        Effect.sync(() => {
          const token = Symbol();
          sessions.set(threadId, { token, control });
          return token;
        }),
      ),
      unregister: Effect.fn("DulliSubagents.unregister")((threadId, token) =>
        Effect.sync(() => {
          if (sessions.get(threadId)?.token === token) sessions.delete(threadId);
        }),
      ),
      control: Effect.fn("DulliSubagents.control")((input) =>
        Effect.suspend(() => {
          const session = sessions.get(input.threadId);
          return session
            ? session.control(input)
            : Effect.fail(
                new ProviderTaskControlError({
                  threadId: input.threadId,
                  taskId: input.taskId,
                  detail: "No live Dulli session for this thread. Send a message first.",
                }),
              );
        }),
      ),
    });
  }),
);
