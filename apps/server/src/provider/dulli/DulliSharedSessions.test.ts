import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { DulliBridgeContext } from "@t3tools/provider-dulli/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as DulliSharedSessions from "./DulliSharedSessions.ts";
const decodeEvent = Schema.decodeUnknownEffect(ProviderAdapter.ProviderAdapterV2Event);
const threadId = ThreadId.make("shared");
const instanceId = ProviderInstanceId.make("dulli");
const setup = Effect.gen(function* () {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const factory = yield* DulliSharedSessions.makeFactory;
  const context: DulliBridgeContext = {
    threadId,
    instanceId,
    providerSessionId: ProviderSessionId.make("shared-session"),
    settings: {
      enabled: true,
      binaryPath: "pi",
      profile: "coder",
      agentDir: "/fake",
      piSessions: true,
      shareWithTerminal: true,
      customModels: [],
    },
    environment: {},
    cwd: "/fake",
    modelSelection: { instanceId, model: "old/model" },
    ids,
    rpc: {
      send: () => Effect.die("Terminal-only UI must not send a reply"),
      request: () => Effect.die("unused"),
    },
    getProviderThread: () => null,
    getActiveTurn: () => null,
    emit: (event) =>
      decodeEvent(event).pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      ),
  };
  const bridge = yield* factory(context);
  return {
    bridge,
    events,
    handle: (type: string, record: Record<string, unknown>) =>
      bridge.events!.find((event) => event.type === type)!.handle(record),
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(DulliSharedSessions.layer, IdAllocator.layer)),
    Effect.scoped,
  );
it.effect(
  "terminal dialogs expose no T3 answer route and settle when terminal closes the prompt",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.handle("pi_sessions_ui_prompt", { phase: "start", title: "Choose a profile" });
        const request = f.events.find((event) => event.type === "runtime_request.updated");
        expect(request).toMatchObject({
          runtimeRequest: {
            status: "pending",
            responseCapability: {
              type: "not_resumable",
              reason: "Waiting for you in the terminal",
            },
          },
        });
        yield* f.handle("pi_sessions_ui_prompt", { phase: "end" });
        expect(f.events.at(-3)).toMatchObject({ runtimeRequest: { status: "resolved" } });
        yield* f.bridge.onStop!();
        expect(f.events).toHaveLength(6);
      }),
    ),
);
it.effect(
  "native model updates are queued off the RPC pump and merge thinking without deleting profile/config options",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.handle("pi_sessions_state", {
          model: { provider: "native", id: "new" },
          thinkingLevel: "high",
        });
        const updates = yield* DulliSharedSessions.DulliSharedModelUpdates;
        expect(yield* Queue.size(updates.queue)).toBe(1);
        const changed = yield* Deferred.make<ModelSelection>();
        const binding = DulliSharedSessions.layerBinding.pipe(
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    modelSelection: {
                      instanceId,
                      model: "old/model",
                      options: [
                        { id: "profile", value: "coder" },
                        { id: "reasoning", value: "low" },
                      ],
                    },
                  },
                } as never),
              dispatch: (command) =>
                Effect.gen(function* () {
                  if (command.type === "thread.model-selection.set")
                    yield* Deferred.succeed(changed, command.modelSelection);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
          ),
        );
        yield* Layer.build(binding);
        expect(yield* Deferred.await(changed)).toEqual({
          instanceId,
          model: "native/new",
          options: [
            { id: "profile", value: "coder" },
            { id: "reasoning", value: "high" },
          ],
        });
      }),
    ),
);
