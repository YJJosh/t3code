import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { DulliBridgeRegistry, type DulliBridgeContext } from "@t3tools/provider-dulli/server";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Background from "./DulliBackgroundThreads.ts";

const parentId = ThreadId.make("parent");
const parent = {
  id: parentId,
  projectId: ProjectId.make("project"),
  branch: "feature",
  worktreePath: "/repo/.worktrees/feature",
  modelSelection: {
    instanceId: ProviderInstanceId.make("custom-dulli"),
    model: "openai-codex/model",
    options: [{ id: "profile", value: "reviewer" }],
  },
  runtimeMode: "full-access",
  interactionMode: "plan",
};
const request = { contractVersion: 1 as const, requestId: "req-1", prompt: "Do this now" };
// The bridge only needs the thread id. No RPC method is called while spawning.
const context = { threadId: parentId } as DulliBridgeContext;

function harness(
  options: {
    failStart?: boolean;
    missingParent?: boolean;
    failCreate?: boolean;
    start?: Effect.Effect<never>;
  } = {},
) {
  const commands: OrchestrationV2ServerCommand[] = [];
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(options.missingParent ? null : (parent as never)),
    dispatch: (command) =>
      Effect.gen(function* () {
        commands.push(command);
        if (command.type === "message.dispatch" && options.start) return yield* options.start;
        if (
          (options.failStart && command.type === "message.dispatch") ||
          (options.failCreate && command.type === "thread.create")
        )
          return yield* Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            }),
          );
        return { storedEvents: [] } as never;
      }),
  });
  const registry = Layer.effect(
    DulliBridgeRegistry,
    Effect.gen(function* () {
      return [yield* Background.makeFactory];
    }),
  );
  // Fake orchestration depends on the registry just like production adapters.
  // Binding is downstream of it; the provider registry must build without it.
  const downstream = threads.pipe(Layer.provideMerge(registry));
  const wired = Background.layerBinding.pipe(
    Layer.provideMerge(downstream),
    Layer.provideMerge(Background.layer),
  );
  return { commands, wired };
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const invoke = (raw: string) =>
  Effect.gen(function* () {
    const factories = yield* DulliBridgeRegistry;
    const bridge = yield* factories[0]!(context);
    expect(bridge.input?.[0]?.titlePrefix).toBe("pi-background-threads:request:v1:");
    const response = yield* bridge.input![0]!.handle(raw, {});
    return yield* decodeJson(response.value);
  });
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "builds the provider→orchestration→binding graph without a cycle and immediately dispatches inherited work",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const response = yield* invoke(encode(request));
      expect(response).toMatchObject({ contractVersion: 1, requestId: "req-1", status: "queued" });
      expect(h.commands.map((c) => c.type)).toEqual(["thread.create", "message.dispatch"]);
      expect(h.commands[0]).toMatchObject({
        projectId: parent.projectId,
        modelSelection: parent.modelSelection,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        branch: parent.branch,
        worktreePath: parent.worktreePath,
        type: "thread.create",
        title: request.prompt,
        createdBy: "agent",
        creationSource: "provider",
      });
      expect(h.commands[1]).toMatchObject({
        text: request.prompt,
        modelSelection: parent.modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
    }).pipe(Effect.provide(h.wired));
  },
);

it.effect(
  "deletes the created child when starting its first prompt fails, with a bounded non-secret error",
  () => {
    const h = harness({ failStart: true });
    return Effect.gen(function* () {
      expect(yield* invoke(encode(request))).toEqual({
        contractVersion: 1,
        requestId: "req-1",
        status: "error",
        error: "Failed to start background thread.",
      });
      expect(h.commands.map((c) => c.type)).toEqual([
        "thread.create",
        "message.dispatch",
        "thread.delete",
      ]);
      expect(h.commands[2]).toMatchObject({
        threadId: (
          h.commands[0] as Extract<OrchestrationV2ServerCommand, { type: "thread.create" }>
        ).threadId,
      });
    }).pipe(Effect.provide(h.wired));
  },
);

it.effect("cleans up a child when the bridge is interrupted while starting its prompt", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const h = harness({
      start: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const fiber = yield* invoke(encode(request)).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(h.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "message.dispatch",
        "thread.delete",
      ]);
    }).pipe(Effect.provide(h.wired));
  }),
);

it.effect("does not delete a child whose create failed", () => {
  const h = harness({ failCreate: true });
  return Effect.gen(function* () {
    yield* invoke(encode(request));
    expect(h.commands.map((c) => c.type)).toEqual(["thread.create"]);
  }).pipe(Effect.provide(h.wired));
});

it.effect("rejects a missing parent without creating work", () => {
  const h = harness({ missingParent: true });
  return Effect.gen(function* () {
    expect(yield* invoke(encode(request))).toMatchObject({
      status: "error",
      error: "Parent thread no longer exists.",
    });
    expect(h.commands).toEqual([]);
  }).pipe(Effect.provide(h.wired));
});

it.effect("validates version, whitespace and protocol size limits before spawning", () => {
  const h = harness();
  return Effect.gen(function* () {
    for (const raw of [
      "not JSON",
      "x".repeat(200_001),
      ...[
        { ...request, contractVersion: 2 },
        { ...request, prompt: " " },
        { ...request, prompt: "x".repeat(32_001) },
        { ...request, requestId: "x".repeat(201) },
        { ...request, title: "x".repeat(201) },
      ].map((value) => encode(value)),
    ])
      expect(yield* invoke(raw)).toMatchObject({ status: "error" });
    expect(h.commands).toEqual([]);
  }).pipe(Effect.provide(h.wired));
});

it.effect("uses an explicit trimmed title or normalized 80-character prompt prefix", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* invoke(encode({ ...request, title: "  My child  " }));
    yield* invoke(encode({ ...request, prompt: `  hello\nworld ${"a".repeat(100)}`, title: " " }));
    expect(h.commands[0]).toMatchObject({ title: "My child" });
    expect(h.commands[2]).toMatchObject({ title: `hello world ${"a".repeat(100)}`.slice(0, 80) });
  }).pipe(Effect.provide(h.wired));
});
