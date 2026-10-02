import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { PiThreadSpawner, PiThreadSpawnError } from "../../provider/Services/PiThreadSpawner.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

export const makePiThreadSpawner = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  return PiThreadSpawner.of({
    spawn: Effect.fn("PiThreadSpawner.spawn")(
      function* (parentThreadId, request) {
        const parent = yield* query.getThreadShellById(parentThreadId);
        if (Option.isNone(parent)) {
          return yield* new PiThreadSpawnError({ message: "Parent thread no longer exists." });
        }
        const thread = parent.value;
        const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId,
          projectId: thread.projectId,
          title: request.title?.trim() || request.prompt.trim().replace(/\s+/g, " ").slice(0, 80),
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          createdAt,
        });
        // Normal intent dispatch lets the provider reactor start the child;
        // no provider-side orchestration import or synthetic provider session.
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            createdAt,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            modelSelection: thread.modelSelection,
            message: {
              messageId: MessageId.make(yield* crypto.randomUUIDv4),
              role: "user",
              text: request.prompt,
              attachments: [],
            },
          })
          .pipe(
            Effect.tapError(() =>
              engine
                .dispatch({
                  type: "thread.delete",
                  commandId: CommandId.make(`pi-spawn-cleanup:${threadId}`),
                  threadId,
                })
                .pipe(Effect.ignore),
            ),
          );
        return threadId;
      },
      Effect.mapError((cause) => new PiThreadSpawnError({ message: cause.message })),
    ),
  });
});

export const PiThreadSpawnerLive = Layer.effect(PiThreadSpawner, makePiThreadSpawner);
