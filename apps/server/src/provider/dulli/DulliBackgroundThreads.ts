import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import type { DulliBridgeFactory } from "@t3tools/provider-dulli/server";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";

const PREFIX = "pi-background-threads:request:v1:";
const Request = Schema.Struct({
  contractVersion: Schema.Literal(1),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
type Request = typeof Request.Type;
const decodeRequest = Schema.decodeUnknownEffect(Request);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class DulliThreadSpawnError extends Schema.TaggedError<DulliThreadSpawnError>()(
  "DulliThreadSpawnError",
  {
    reason: Schema.Literals(["invalid-request", "parent-missing", "launch-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "invalid-request":
        return "Invalid background-thread request (v1, prompt 1–32000 chars, title ≤200, requestId 1–200 required).";
      case "parent-missing":
        return "Parent thread no longer exists.";
      case "launch-failed":
        return "Failed to start background thread.";
    }
  }
}

const isSpawnError = Schema.is(DulliThreadSpawnError);
type Spawn = (parent: ThreadId, request: Request) => Effect.Effect<ThreadId, DulliThreadSpawnError>;

/** Providers are hydrated before orchestration exists. Bind once after v2 is built;
 * requests await the binding, never build a second orchestration/adapter graph. */
export class DulliThreadSpawner extends Context.Service<
  DulliThreadSpawner,
  {
    readonly spawn: Spawn;
    readonly bind: (spawn: Spawn) => Effect.Effect<void>;
  }
>()("t3/provider/dulli/DulliBackgroundThreads/DulliThreadSpawner") {}

export const layer = Layer.effect(
  DulliThreadSpawner,
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Spawn>();
    return DulliThreadSpawner.of({
      spawn: (parent, request) =>
        Deferred.await(ready).pipe(Effect.flatMap((spawn) => spawn(parent, request))),
      bind: (spawn) => Deferred.succeed(ready, spawn).pipe(Effect.asVoid),
    });
  }),
);

export const layerBinding = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const spawner = yield* DulliThreadSpawner;
    yield* spawner.bind((parentThreadId, request) =>
      Effect.gen(function* () {
        const parent = yield* threads.getThreadShell(parentThreadId);
        if (parent === null) return yield* new DulliThreadSpawnError({ reason: "parent-missing" });
        const threadId = ThreadId.make(yield* randomUuidV4);
        const commandId = CommandId.make(yield* randomUuidV4);
        // Same commands and enablement checks as clients/MCP. Do not provision a
        // fresh workspace or run setup: these threads intentionally share files.
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* threads.dispatch({
              type: "thread.create",
              commandId,
              threadId,
              projectId: parent.projectId,
              title:
                request.title?.trim() || request.prompt.trim().replace(/\s+/g, " ").slice(0, 80),
              modelSelection: parent.modelSelection,
              runtimeMode: parent.runtimeMode,
              interactionMode: parent.interactionMode,
              branch: parent.branch,
              worktreePath: parent.worktreePath,
              createdBy: "agent",
              creationSource: "provider",
            });
            yield* restore(
              Effect.gen(function* () {
                const messageId = MessageId.make(yield* randomUuidV4);
                yield* threads.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`${commandId}:prompt`),
                  threadId,
                  messageId,
                  text: request.prompt,
                  attachments: [],
                  dispatchMode: { type: "start_immediately" },
                  modelSelection: parent.modelSelection,
                  createdBy: "agent",
                  creationSource: "provider",
                });
              }),
            ).pipe(
              Effect.onError(() =>
                threads
                  .dispatch({
                    type: "thread.delete",
                    commandId: CommandId.make(`${commandId}:cleanup`),
                    threadId,
                  })
                  .pipe(Effect.ignoreCause),
              ),
            );
          }),
        );
        return threadId;
      }).pipe(
        Effect.mapError((cause) =>
          isSpawnError(cause)
            ? cause
            : new DulliThreadSpawnError({ reason: "launch-failed", cause }),
        ),
      ),
    );
  }),
);

export const makeFactory = Effect.gen(function* () {
  const spawner = yield* DulliThreadSpawner;
  const factory: DulliBridgeFactory = (context) =>
    Effect.succeed({
      input: [
        {
          titlePrefix: PREFIX,
          handle: (raw) =>
            Effect.gen(function* () {
              let requestId = "";
              const operation = Effect.gen(function* () {
                if (raw.length > 200_000)
                  return yield* new DulliThreadSpawnError({ reason: "invalid-request" });
                const parsed: unknown = yield* decodeJson(raw).pipe(
                  Effect.mapError(() => new DulliThreadSpawnError({ reason: "invalid-request" })),
                );
                if (
                  typeof parsed === "object" &&
                  parsed !== null &&
                  "requestId" in parsed &&
                  typeof parsed.requestId === "string"
                )
                  requestId = parsed.requestId.slice(0, 200);
                const request = yield* decodeRequest(parsed).pipe(
                  Effect.mapError(() => new DulliThreadSpawnError({ reason: "invalid-request" })),
                );
                if (!request.prompt.trim())
                  return yield* new DulliThreadSpawnError({ reason: "invalid-request" });
                const threadId = yield* spawner.spawn(context.threadId, request);
                return {
                  contractVersion: 1,
                  requestId: request.requestId,
                  status: "queued",
                  threadId,
                };
              });
              const result = yield* operation.pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    contractVersion: 1,
                    requestId,
                    status: "error",
                    error: error.message.slice(0, 4096),
                  }),
                ),
              );
              return {
                value: yield* encodeJson(result).pipe(Effect.orDie),
              };
            }),
        },
      ],
    });
  return factory;
});
