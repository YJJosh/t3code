import {
  CommandId,
  ProviderDriverKind,
  type ThreadId,
  type ProviderInstanceId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { DulliBridgeFactory } from "@t3tools/provider-dulli/server";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";

interface ModelUpdate {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly thinking?: string;
}
/** The provider event pump must not wait for commands that can call back into its RPC. */
export class DulliSharedModelUpdates extends Context.Service<
  DulliSharedModelUpdates,
  { readonly queue: Queue.Queue<ModelUpdate> }
>()("t3/provider/dulli/DulliSharedSessions/DulliSharedModelUpdates") {}
export const layer = Layer.effect(
  DulliSharedModelUpdates,
  Effect.gen(function* () {
    return { queue: yield* Queue.unbounded<ModelUpdate>() };
  }),
);
export const layerBinding = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const updates = yield* DulliSharedModelUpdates;
    yield* Effect.gen(function* () {
      while (true) {
        const update = yield* Queue.take(updates.queue);
        yield* Effect.gen(function* () {
          const records = yield* orchestrator.getThreadRecords(update.threadId, []);
          const current = records.thread.modelSelection;
          if (current.instanceId !== update.instanceId) return;
          if (
            current.model === update.model &&
            (update.thinking === undefined ||
              current.options?.find((option) => option.id === "reasoning")?.value ===
                update.thinking)
          )
            return;
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            threadId: update.threadId,
            commandId: CommandId.make(`pi-sessions:model:${yield* randomUuidV4}`),
            modelSelection: {
              ...current,
              model: update.model,
              ...(update.thinking === undefined
                ? {}
                : {
                    options: [
                      ...(current.options ?? []).filter((option) => option.id !== "reasoning"),
                      { id: "reasoning", value: update.thinking },
                    ],
                  }),
            },
          });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Dulli terminal model update skipped", { cause }),
          ),
        );
      }
    }).pipe(Effect.forkScoped);
  }),
);

/** Persist terminal model changes through commands; terminal dialogs have no T3 response route. */
export const makeFactory = Effect.gen(function* () {
  const updates = yield* DulliSharedModelUpdates;
  const factory: DulliBridgeFactory = (context) =>
    Effect.sync(() => {
      const driver = ProviderDriverKind.make("dulli");
      let pending:
        | {
            request: OrchestrationV2RuntimeRequest;
            node: OrchestrationV2ExecutionNode;
            item: OrchestrationV2TurnItem;
          }
        | undefined;
      const closePrompt = Effect.gen(function* () {
        if (!pending) return;
        const at = yield* DateTime.now;
        yield* context.emit({
          type: "runtime_request.updated",
          driver,
          threadId: context.threadId,
          runtimeRequest: { ...pending.request, status: "resolved", resolvedAt: at },
        });
        yield* context.emit({
          type: "node.updated",
          driver,
          node: { ...pending.node, status: "completed", completedAt: at },
        });
        yield* context.emit({
          type: "turn_item.updated",
          driver,
          turnItem: { ...pending.item, status: "completed", completedAt: at, updatedAt: at },
        });
        pending = undefined;
      });
      return {
        onStop: () => closePrompt,
        events: [
          {
            type: "pi_sessions_state",
            // Model state is handled on the provider event pump.
            handle: Effect.fnUntraced(function* (event) {
              const model = event.model;
              if (
                typeof model !== "object" ||
                model === null ||
                !("provider" in model) ||
                !("id" in model) ||
                typeof model.provider !== "string" ||
                typeof model.id !== "string"
              )
                return;
              yield* Queue.offer(updates.queue, {
                threadId: context.threadId,
                instanceId: context.instanceId,
                model: `${model.provider}/${model.id}`,
                ...(typeof event.thinkingLevel === "string"
                  ? { thinking: event.thinkingLevel }
                  : {}),
              });
            }),
          },
          {
            type: "pi_sessions_ui_prompt",
            // Prompt state is projected on the provider event pump.
            handle: Effect.fnUntraced(
              function* (event) {
                yield* closePrompt;
                if (event.phase !== "start") return;
                const at = yield* DateTime.now;
                const requestId = yield* context.ids.allocate.runtimeRequest({ driver });
                const nodeId = context.ids.derive.approvalNode({ requestId });
                const providerThreadId = context.getProviderThread()?.id ?? null;
                const request: OrchestrationV2RuntimeRequest = {
                  id: requestId,
                  nodeId,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: {
                    type: "not_resumable",
                    reason: "Waiting for you in the terminal",
                  },
                  createdAt: at,
                  resolvedAt: null,
                };
                const node: OrchestrationV2ExecutionNode = {
                  id: nodeId,
                  threadId: context.threadId,
                  runId: null,
                  parentNodeId: null,
                  rootNodeId: nodeId,
                  kind: "user_input_request",
                  status: "waiting",
                  countsForRun: false,
                  providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  runtimeRequestId: requestId,
                  checkpointScopeId: null,
                  startedAt: at,
                  completedAt: null,
                };
                const item: OrchestrationV2TurnItem = {
                  id: context.ids.derive.approvalTurnItem({ requestId }),
                  threadId: context.threadId,
                  runId: null,
                  nodeId,
                  providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  status: "waiting",
                  title: "Waiting for you in the terminal",
                  startedAt: at,
                  completedAt: null,
                  updatedAt: at,
                  type: "user_input_request",
                  requestId,
                  questions: [
                    {
                      id: "terminal",
                      header: "Waiting for you in the terminal",
                      question:
                        typeof event.title === "string" && event.title.trim()
                          ? event.title
                          : "Answer the Pi dialog in the terminal.",
                      options: [],
                      allowCustomAnswer: false,
                    },
                  ],
                };
                pending = { request, node, item };
                yield* context.emit({
                  type: "runtime_request.updated",
                  driver,
                  threadId: context.threadId,
                  runtimeRequest: request,
                });
                yield* context.emit({ type: "node.updated", driver, node });
                yield* context.emit({ type: "turn_item.updated", driver, turnItem: item });
              },
              Effect.catch((cause) =>
                Effect.logWarning("Dulli terminal prompt update skipped", { cause }),
              ),
            ),
          },
        ],
      };
    });
  return factory;
});
