import { expect, it } from "@effect/vitest";
import {
  ProviderSessionId,
  ProviderInstanceId,
  ThreadId,
  DulliBackgroundTerminalEvent,
} from "@t3tools/contracts";
import { DulliSettings } from "@t3tools/provider-dulli/settings";
import type { DulliBridge, DulliBridgeContext } from "@t3tools/provider-dulli/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Service from "./DulliBackgroundTerminals.ts";
import { makeFactory } from "./DulliBackgroundTerminalBridge.ts";

const instanceId = ProviderInstanceId.make("dulli");
const providerSessionId = ProviderSessionId.make("session");
const threadId = ThreadId.make("thread");
const liveContext = {
  thread: {
    archivedAt: null,
    activeProviderThreadId: "provider-thread",
    modelSelection: { instanceId },
  },
  providerThreads: [{ id: "provider-thread", providerSessionId, driver: "dulli" }],
  providerSessions: [],
} as unknown as ProjectionStore.ProjectionThreadProviderContext;
const testLayer = Service.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadProviderContext: () => Effect.succeed(liveContext),
    }),
  ),
);
const otherThread = ThreadId.make("other");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownSync(DulliBackgroundTerminalEvent);
const settings = Schema.decodeUnknownSync(DulliSettings)({});
const event = (sequence: number, managerId = "manager") =>
  decodeEvent({
    contractVersion: 1,
    managerId,
    sequence,
    timestamp: "2026-01-01T00:00:00Z",
    kind: "snapshot",
    snapshot: { terminals: [] },
  });
const notify = (bridge: DulliBridge, value: unknown) =>
  bridge.notify![0]!.handle(encode(value), {});

const harness = Effect.gen(function* () {
  const service = yield* Service.DulliBackgroundTerminals;
  const factory = yield* makeFactory;
  const prompted = yield* Deferred.make<void>();
  const sent: Record<string, unknown>[] = [];
  let advertised = true;
  const context: DulliBridgeContext = {
    threadId,
    providerSessionId,
    instanceId,
    settings,
    environment: {},
    cwd: "/repo",
    modelSelection: { instanceId: ProviderInstanceId.make("dulli"), model: "default" },
    emit: () => Effect.void,
    ids: {} as DulliBridgeContext["ids"],
    getProviderThread: () => null,
    getActiveTurn: () => null,
    rpc: {
      send: () => Effect.void,
      request: (input: Record<string, unknown>) =>
        Effect.gen(function* () {
          sent.push(input);
          if (input.type === "get_commands")
            return { commands: advertised ? [{ name: "background-terminals-rpc" }] : [] };
          yield* Deferred.succeed(prompted, undefined);
          return undefined;
        }),
    },
  };
  const bridge = yield* factory(context);
  yield* bridge.onStart!();
  return {
    bridge,
    service,
    context,
    sent,
    prompted,
    disable: () => {
      advertised = false;
    },
  };
});

it.effect(
  "never starts a provider; rejects absent, stale, unknown-extension and duplicate controls",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        expect(
          (yield* h.service.control({ threadId: otherThread, action: "replay" }).pipe(Effect.flip))
            ._tag,
        ).toBe("DulliBackgroundTerminalControlError");
        expect(
          (yield* h.service
            .control({ threadId, action: "start", managerId: "old", command: "echo hi" })
            .pipe(Effect.flip)).message,
        ).toContain("stale");
        expect(h.sent).toEqual([]);
        h.disable();
        expect(
          (yield* h.service.control({ threadId, action: "replay" }).pipe(Effect.flip)).message,
        ).toContain("not installed");
        expect(h.sent.map((r) => r.type)).toEqual(["get_commands"]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "waits for matching extension result, not prompt acceptance; preserves native envelope and live cwd ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* notify(h.bridge, event(1));
        const fiber = yield* h.service
          .control({
            threadId,
            action: "start",
            managerId: "manager",
            requestId: "request",
            command: "bash -i",
            interactive: true,
            keepOpen: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.prompted);
        expect(
          decodeJson(String(h.sent[1]!.message).slice("/background-terminals-rpc ".length)),
        ).toEqual({
          action: "start",
          request_id: "request",
          command: "bash -i",
          interactive: true,
          keep_open: true,
        });
        // cwd is deliberately absent: the live Pi extension owns it.
        const duplicate = yield* h.service
          .control({ threadId, action: "replay", requestId: "request" })
          .pipe(Effect.flip);
        expect(duplicate.message).toContain("already pending");
        const pull = yield* Stream.toPull(h.service.streamEvents(threadId));
        const first = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
        yield* notify(h.bridge, {
          ...event(2),
          kind: "control_result",
          control: { requestId: "unrelated", action: "start", success: true },
        });
        yield* Fiber.join(first);
        yield* notify(h.bridge, {
          ...event(3),
          kind: "control_result",
          control: { requestId: "request", action: "start", success: true, terminalId: "bt-1" },
        });
        yield* Fiber.join(fiber);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("rejects wrong-action results and releases pending controls on stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      yield* notify(h.bridge, event(1));
      const fiber = yield* h.service
        .control({ threadId, action: "replay", requestId: "request" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(h.prompted);
      yield* notify(h.bridge, {
        ...event(2),
        kind: "control_result",
        control: { requestId: "request", action: "kill", success: true },
      });
      expect((yield* Fiber.join(fiber)).message).toContain("rejected");
      const pending = yield* h.service
        .control({ threadId, action: "replay", requestId: "next" })
        .pipe(Effect.flip, Effect.forkChild);
      // Wait until get_commands and prompt are delivered, without sleeps or polling.
      yield* Effect.yieldNow;
      yield* h.bridge.onStop!("stopped");
      expect((yield* Fiber.join(pending))._tag).toBe("DulliBackgroundTerminalControlError");
      expect(
        (yield* h.service.control({ threadId, action: "replay" }).pipe(Effect.flip)).message,
      ).toContain("No live");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect.each(["detached", "stopped"] as const)(
  "streams only this thread; %s resets the epoch and a replaced session cannot clear/publish into its successor",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const pull = yield* Stream.toPull(h.service.streamEvents(threadId));
        const first = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
        const otherToken = yield* h.service.register(
          otherThread,
          { instanceId, providerSessionId },
          () => Effect.void,
        );
        yield* h.service.publish(otherThread, otherToken, event(9));
        yield* notify(h.bridge, event(1));
        expect((yield* Fiber.join(first))[0]?.managerId).toBe("manager");
        // A foreign non-snapshot cannot change the current epoch.
        yield* notify(h.bridge, {
          ...event(2, "old"),
          kind: "terminal_removed",
          terminalId: "bt-1",
        });
        const factory = yield* makeFactory;
        const replacement = yield* factory(h.context);
        yield* replacement.onStart!();
        expect((yield* pull)[0]?.managerId).toMatch(/^dulli-session-/);
        yield* h.bridge.onStop!(reason);
        yield* notify(h.bridge, event(3));
        yield* notify(replacement, event(1, "replacement"));
        expect((yield* pull)[0]?.managerId).toBe("replacement");
        yield* replacement.onStop!(reason);
        expect((yield* pull)[0]).toMatchObject({
          managerId: expect.stringMatching(/^dulli-session-/),
          kind: "snapshot",
          snapshot: { terminals: [] },
        });
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("bounds suspended subscribers with a sliding feed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const pull = yield* Stream.toPull(h.service.streamEvents(threadId));
      const first = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
      yield* notify(h.bridge, event(1));
      yield* Fiber.join(first);
      for (let sequence = 2; sequence <= 300; sequence++) yield* notify(h.bridge, event(sequence));
      expect((yield* pull)[0]?.sequence).toBe(45);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("times out an accepted prompt without a correlated result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const fiber = yield* h.service
        .control({ threadId, action: "replay", requestId: "missing" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(h.prompted);
      yield* TestClock.adjust("12 seconds");
      expect((yield* Fiber.join(fiber)).message).toContain("timed out");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "retains the v2 live session while a background command is running, without creating thread activity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        expect(h.bridge.hasPendingBackgroundWork!()).toBe(false);
        const view = {
          id: "bt-1",
          command: "sleep 10",
          title: "test",
          cwd: "/live-cwd",
          status: "running",
          createdAt: 1,
          stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
          stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
        };
        yield* notify(h.bridge, { ...event(1), snapshot: { terminals: [view] } });
        expect(h.bridge.hasPendingBackgroundWork!()).toBe(true);
        yield* notify(h.bridge, {
          ...event(2),
          kind: "terminal_upsert",
          terminalId: "bt-1",
          view: { ...view, status: "done" },
        });
        expect(h.bridge.hasPendingBackgroundWork!()).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a still-resident session after provider switch instead of routing to it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      const stale = yield* h.service.control({ threadId, action: "replay" }).pipe(Effect.flip);
      expect(stale.message).toContain("no longer active");
      expect(h.sent).toEqual([]);
    }),
  ).pipe(
    Effect.provide(
      Service.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProviderContext: () =>
              Effect.succeed({
                ...liveContext,
                thread: {
                  ...liveContext.thread,
                  modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
                },
              }),
          }),
        ),
      ),
    ),
  ),
);
