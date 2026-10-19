import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2DomainEvent,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  type ProviderTaskControlInput,
} from "@t3tools/contracts";
import type { DulliBridgeContext } from "@t3tools/provider-dulli/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { makeSubagentFactory, SUBAGENT_PREFIX } from "./DulliSubagentBridge.ts";
import * as DulliSubagents from "./DulliSubagents.ts";

const decodeAdapterEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);
const THREAD = ThreadId.make("dulli-parent");
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const envelope = (fields: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  managerId: "manager",
  sequence: 1,
  timestamp: "2026-01-01T00:00:00.000Z",
  kind: "run_created",
  runId: "child",
  view: {
    runId: "child",
    task: "Inspect the code",
    state: "running",
    model: "anthropic/claude",
    effort: "high",
  },
  ...fields,
});
const setup = Effect.fnUntraced(function* () {
  const controls = yield* DulliSubagents.DulliSubagents;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const requests = yield* Queue.unbounded<Record<string, unknown>>();
  const events: Array<OrchestrationV2DomainEvent> = [];
  const agents = new Map<string, OrchestrationV2Subagent>();
  const items = new Map<string, OrchestrationV2TurnItem>();
  let commands = ["subagents-rpc"];
  const context: DulliBridgeContext = {
    threadId: THREAD,
    providerSessionId: ProviderSessionId.make("session"),
    instanceId: ProviderInstanceId.make("dulli"),
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
    modelSelection: { instanceId: ProviderInstanceId.make("dulli"), model: "default" },
    ids,
    getProviderThread: () => null,
    getActiveTurn: () => null,
    rpc: {
      send: (value) => Queue.offer(requests, value).pipe(Effect.asVoid),
      request: (value) =>
        Effect.gen(function* () {
          yield* Queue.offer(requests, value);
          return value.type === "get_commands"
            ? { commands: commands.map((name) => ({ name })) }
            : undefined;
        }),
    },
    emit: () => Effect.die("Pi runs must never emit upstream provider events"),
  };
  const factory = makeSubagentFactory({
    controls,
    write: (event) =>
      decodeAdapterEvent(event).pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.sync(() => {
            events.push(event);
            if (event.type === "dulli-run.updated") agents.set(event.payload.id, event.payload);
            if (event.type === "dulli-transcript.updated")
              items.set(event.payload.id, event.payload);
          }),
        ),
      ),
    read: () => Effect.succeed({ subagents: [...agents.values()], turnItems: [...items.values()] }),
  });
  const bridge = yield* factory(context);
  const notify = (value: unknown) => bridge.notify![0]!.handle(encode(value), {});
  const takePrompt = Effect.gen(function* () {
    while (true) {
      const value = yield* Queue.take(requests);
      if (value.type === "prompt") return value;
    }
  });
  return {
    context,
    factory,
    bridge,
    notify,
    events,
    agents,
    items,
    controls,
    requests,
    takePrompt,
    setCommands: (names: string[]) => {
      commands = names;
    },
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(DulliSubagents.layer.pipe(Layer.provideMerge(IdAllocator.layer))),
    Effect.scoped,
  );

describe("Dulli pi-subagents v2 bridge", () => {
  it.effect("projects lifecycle, linkage, selected child effort and usage as v2 records", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* setup();
        assert.equal(h.bridge.notify![0]!.prefix, SUBAGENT_PREFIX);
        assert.isUndefined(h.bridge.hasPendingBackgroundWork);
        assert.isUndefined(h.bridge.stopSubagent);
        yield* h.notify(
          envelope({
            view: {
              ...envelope().view,
              usageSoFar: { total: 100, input: 60, output: 40, turns: 2 },
              workflow: {
                runId: "workflow",
                name: "Review",
                phase: "Investigate",
                label: "Reader",
              },
            },
          }),
        );
        const child = [...h.agents.values()].find(
          (agent) => agent.nativeTaskRef?.nativeId === "child",
        )!;
        const workflow = [...h.agents.values()].find(
          (agent) => agent.nativeTaskRef?.nativeId === "workflow",
        )!;
        assert.equal(child.parentNodeId, workflow.id);
        assert.equal(child.model, "anthropic/claude");
        assert.deepEqual(child.modelSelection?.options, [{ id: "reasoning", value: "high" }]);
        assert.equal(child.usage?.totalTokens, 100);
        assert.equal(workflow.workflow?.phases[0]?.title, "Investigate");
        assert.equal(workflow.workflow?.agents[0]?.model, child.model);
        yield* h.notify(envelope({ sequence: 2, kind: "needs_input" }));
        assert.equal(h.agents.get(child.id)?.status, "waiting");
        yield* h.notify(
          envelope({
            sequence: 3,
            kind: "terminal",
            view: {
              ...envelope().view,
              state: "done",
              result: { result: { summary: "Found it" } },
            },
          }),
        );
        assert.equal(h.agents.get(child.id)?.status, "completed");
        assert.equal(h.agents.get(child.id)?.result, "Found it");
      }),
    ),
  );

  it.effect(
    "replays current terminal state without ever publishing an old running lifecycle, across reload",
    () =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          const done = { ...envelope().view, state: "done" };
          yield* h.notify(envelope({ kind: "terminal", sequence: 10, view: done }));
          h.events.length = 0;
          const reopened = yield* h.factory(h.context);
          yield* reopened.notify![0]!.handle(
            encode(
              envelope({
                kind: "snapshot",
                sequence: 11,
                snapshot: {
                  runs: [done],
                  events: [
                    envelope({ kind: "run_running", activity: { type: "message_end", data: {} } }),
                    envelope({
                      kind: "activity",
                      sequence: 5,
                      activity: {
                        type: "message_end",
                        data: {
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "Historical answer" }],
                          },
                        },
                      },
                    }),
                  ],
                },
              }),
            ),
            {},
          );
          assert.isTrue(
            h.events
              .filter((event) => event.type === "dulli-run.updated")
              .every((event) => event.payload.status === "completed"),
          );
          assert.isTrue(
            [...h.items.values()].some(
              (item) => item.type === "assistant_message" && item.text === "Historical answer",
            ),
          );
          const before = h.events.length;
          yield* reopened.notify![0]!.handle(
            encode(
              envelope({ kind: "snapshot", sequence: 11, snapshot: { runs: [done], events: [] } }),
            ),
            {},
          );
          assert.equal(h.events.length, before);
        }),
      ),
  );

  it.effect(
    "coalesces live cumulative thinking/text and tools to 1s, persists final output and ignores duration-only usage",
    () =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          yield* h.notify(
            envelope({ view: { ...envelope().view, usageSoFar: { total: 10 }, activeMs: 10 } }),
          );
          h.events.length = 0;
          for (const [sequence, timestamp, delta] of [
            [2, "00.000", "a"],
            [3, "00.100", "b"],
            [4, "01.000", "c"],
          ] as const) {
            yield* h.notify(
              envelope({
                sequence,
                timestamp: `2026-01-01T00:00:${timestamp}Z`,
                kind: "activity",
                view: { ...envelope().view, usageSoFar: { total: 10 }, activeMs: sequence * 100 },
                activity: {
                  type: "message_update",
                  liveOnly: true,
                  data: { assistantMessageEvent: { type: "text_delta", delta } },
                },
              }),
            );
          }
          const messages = h.events.flatMap((event) =>
            event.type === "dulli-transcript.updated" && event.payload.type === "assistant_message"
              ? [event.payload.text]
              : [],
          );
          assert.deepEqual(messages, ["a", "abc"]);
          assert.equal(h.events.filter((event) => event.type === "dulli-run.updated").length, 0);
          yield* h.notify(
            envelope({
              sequence: 5,
              kind: "activity",
              timestamp: "2026-01-01T00:00:01.100Z",
              activity: {
                type: "message_end",
                data: {
                  message: {
                    role: "assistant",
                    content: [
                      { type: "thinking", thinking: "reason" },
                      { type: "text", text: "answer" },
                    ],
                  },
                },
              },
            }),
          );
          assert.isTrue(
            [...h.items.values()].some(
              (item) => item.type === "reasoning" && item.text === "reason",
            ),
          );
          assert.isTrue(
            [...h.items.values()].some(
              (item) =>
                item.type === "assistant_message" && item.text === "answer" && !item.streaming,
            ),
          );
        }),
      ),
  );

  it.effect("never sends a missing private slash command, and rechecks on every control", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.bridge.onStart!();
        yield* h.takePrompt; // replay
        h.setCommands([]);
        const result = yield* h.controls
          .control({ threadId: THREAD, taskId: "child", action: "stop" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal((yield* Queue.take(h.requests)).type, "get_commands");
        assert.equal(yield* Queue.size(h.requests), 0);
      }),
    ),
  );

  it.effect.each(["steer", "reply", "stop"] as const)(
    "awaits correlated %s result rather than treating prompt acceptance as success",
    (action) =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          yield* h.bridge.onStart!();
          yield* h.takePrompt;
          const input: ProviderTaskControlInput =
            action === "stop"
              ? { threadId: THREAD, taskId: "child", action }
              : { threadId: THREAD, taskId: "child", action, message: "Continue" };
          const pending = yield* h.controls.control(input).pipe(Effect.forkScoped);
          const prompt = yield* h.takePrompt;
          const payload = decode(String(prompt.message).slice("/subagents-rpc ".length));
          assert.equal(payload.run_id, "child");
          assert.equal(payload.action, action === "stop" ? "kill" : action);
          yield* h.notify(
            envelope({
              kind: "control_result",
              control: { requestId: "unrelated", action: payload.action, success: true },
            }),
          );
          assert.equal(pending.pollUnsafe(), undefined);
          yield* h.notify(
            envelope({
              kind: "control_result",
              control: { requestId: payload.request_id, action: payload.action, success: true },
            }),
          );
          yield* Fiber.join(pending);
        }),
      ),
  );

  it.effect(
    "fails rejected, wrong-action, timed-out and disconnected controls without recovery",
    () =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          const missing = yield* h.controls
            .control({ threadId: THREAD, taskId: "child", action: "stop" })
            .pipe(Effect.result);
          assert.equal(missing._tag, "Failure");
          yield* h.bridge.onStart!();
          yield* h.takePrompt;
          for (const result of [
            { action: "kill", success: false },
            { action: "reply", success: true },
          ]) {
            const fiber = yield* h.controls
              .control({ threadId: THREAD, taskId: "child", action: "stop" })
              .pipe(Effect.result, Effect.forkScoped);
            const prompt = yield* h.takePrompt;
            const payload = decode(String(prompt.message).slice("/subagents-rpc ".length));
            yield* h.notify(
              envelope({
                kind: "control_result",
                control: { requestId: payload.request_id, ...result },
              }),
            );
            assert.equal((yield* Fiber.join(fiber))._tag, "Failure");
          }
          const timeout = yield* h.controls
            .control({ threadId: THREAD, taskId: "child", action: "stop" })
            .pipe(Effect.result, Effect.forkScoped);
          yield* h.takePrompt;
          yield* TestClock.adjust("12 seconds");
          assert.equal((yield* Fiber.join(timeout))._tag, "Failure");
          const disconnected = yield* h.controls
            .control({ threadId: THREAD, taskId: "child", action: "stop" })
            .pipe(Effect.result, Effect.forkScoped);
          yield* h.takePrompt;
          yield* h.bridge.onStop!("stopped");
          assert.equal((yield* Fiber.join(disconnected))._tag, "Failure");
          assert.equal(
            (yield* h.controls
              .control({ threadId: THREAD, taskId: "child", action: "stop" })
              .pipe(Effect.result))._tag,
            "Failure",
          );
        }),
      ),
  );

  it.effect(
    "retains child user messages, redacted reasoning and provider tool transcripts without leaking redacted text",
    () =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          yield* h.notify(envelope());
          yield* h.notify(
            envelope({
              kind: "activity",
              sequence: 2,
              activity: {
                type: "message_end",
                data: { message: { role: "user", content: [{ type: "text", text: "Follow up" }] } },
              },
            }),
          );
          yield* h.notify(
            envelope({
              kind: "activity",
              sequence: 3,
              activity: {
                type: "message_end",
                data: {
                  message: {
                    role: "assistant",
                    content: [
                      { type: "thinking", thinking: "secret", redacted: true },
                      {
                        type: "toolCall",
                        id: "call",
                        name: "read",
                        arguments: { path: "file.ts" },
                      },
                    ],
                  },
                },
              },
            }),
          );
          yield* h.notify(
            envelope({
              kind: "activity",
              sequence: 4,
              activity: {
                type: "provider_tool_execution_start",
                data: { toolCallId: "call", toolName: "read", args: { path: "file.ts" } },
              },
            }),
          );
          yield* h.notify(
            envelope({
              kind: "activity",
              sequence: 5,
              activity: {
                type: "message_end",
                data: {
                  message: {
                    role: "toolResult",
                    toolCallId: "call",
                    toolName: "read",
                    content: [{ type: "text", text: "file contents" }],
                  },
                },
              },
            }),
          );
          const items = [...h.items.values()];
          assert.isTrue(
            items.some((item) => item.type === "user_message" && item.text === "Follow up"),
          );
          assert.isTrue(
            items.some((item) => item.type === "reasoning" && item.text === "[redacted reasoning]"),
          );
          const tool = items.find((item) => item.type === "dynamic_tool");
          assert.isTrue(
            tool?.type === "dynamic_tool" &&
              tool.toolName === "read" &&
              tool.output === "file contents" &&
              String(tool.input).includes("file.ts"),
          );
          assert.equal(tool?.status, "completed");
        }),
      ),
  );

  it.effect(
    "bounds durable transcript rows and aggregate text across reload while retaining large answers",
    () =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          yield* h.notify(envelope());
          const answer = (sequence: number, value: string) =>
            envelope({
              kind: "activity",
              sequence,
              activity: {
                type: "message_end",
                data: { message: { role: "assistant", content: [{ type: "text", text: value }] } },
              },
            });
          for (let sequence = 2; sequence < 1007; sequence++)
            yield* h.notify(answer(sequence, `answer ${sequence}`));
          const transcript = () =>
            [...h.items.values()].filter((item) => item.id.includes(":transcript:"));
          assert.equal(transcript().length, 1000);
          assert.isTrue(
            transcript().some(
              (item) => item.type === "assistant_message" && item.text === "answer 1006",
            ),
          );
          assert.isFalse(
            transcript().some(
              (item) => item.type === "assistant_message" && item.text === "answer 2",
            ),
          );
          const large = "x".repeat(1024 * 1024 + 100);
          yield* h.notify(answer(1008, large));
          assert.isTrue(
            transcript().some((item) => item.type === "assistant_message" && item.text === large),
          );
          yield* h.notify(answer(1009, large));
          const bytes = transcript().reduce(
            (sum, item) =>
              sum + (item.type === "assistant_message" ? Buffer.byteLength(item.text) : 0),
            0,
          );
          assert.isAtMost(bytes, 2 * 1024 * 1024);
          const reopened = yield* h.factory(h.context);
          h.events.length = 0;
          yield* reopened.notify![0]!.handle(encode(answer(1009, large)), {});
          assert.equal(h.events.length, 0);
        }),
      ),
  );

  it.effect.each(["running", "waiting"] as const)(
    "preserves a %s child on shared detach and restores live controls after reconnect",
    (status) =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          yield* h.bridge.onStart!();
          yield* h.takePrompt;
          yield* h.notify(envelope({ kind: status === "waiting" ? "needs_input" : "run_running" }));
          yield* h.bridge.onStop!("detached");
          assert.equal([...h.agents.values()][0]?.status, status);
          assert.equal([...h.agents.values()][0]?.completedAt, null);
          assert.equal(
            (yield* h.controls
              .control({ threadId: THREAD, taskId: "child", action: "stop" })
              .pipe(Effect.result))._tag,
            "Failure",
          );

          const reopened = yield* h.factory(h.context);
          yield* reopened.onStart!();
          yield* h.takePrompt;
          yield* reopened.notify![0]!.handle(
            encode(
              envelope({
                kind: "snapshot",
                sequence: 2,
                snapshot: { runs: [envelope().view], events: [] },
              }),
            ),
            {},
          );
          const child = [...h.agents.values()][0]!;
          assert.equal(child.status, "running");
          assert.equal(child.completedAt, null);
          assert.equal(
            [...h.items.values()].find((item) => item.type === "subagent")?.status,
            "running",
          );
          const pending = yield* h.controls
            .control({
              threadId: THREAD,
              taskId: "child",
              action: "steer",
              message: "Continue",
            })
            .pipe(Effect.forkScoped);
          const prompt = yield* h.takePrompt;
          const payload = decode(String(prompt.message).slice("/subagents-rpc ".length));
          assert.equal(payload.action, "steer");
          yield* reopened.notify![0]!.handle(
            encode(
              envelope({
                kind: "control_result",
                sequence: 3,
                control: { requestId: payload.request_id, action: "steer", success: true },
              }),
            ),
            {},
          );
          yield* Fiber.join(pending);
        }),
      ),
  );

  it.effect(
    "does not reopen an ended child from a stale snapshot and interrupts remaining children on session exit",
    () =>
      provide(
        Effect.gen(function* () {
          const h = yield* setup();
          yield* h.notify(
            envelope({ kind: "terminal", view: { ...envelope().view, state: "done" } }),
          );
          yield* h.notify(
            envelope({
              kind: "snapshot",
              sequence: 2,
              snapshot: { runs: [envelope().view], events: [] },
            }),
          );
          assert.equal([...h.agents.values()][0]?.status, "completed");
          yield* h.notify(
            envelope({ kind: "resumed", sequence: 3, timestamp: "2026-01-01T00:01:00.000Z" }),
          );
          assert.equal([...h.agents.values()][0]?.status, "running");
          yield* h.bridge.onStop!("stopped");
          assert.equal([...h.agents.values()][0]?.status, "interrupted");
        }),
      ),
  );

  it.effect("ignores malformed notifications without creating model work", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.bridge.notify![0]!.handle("not json", {});
        yield* h.notify({ ...envelope(), contractVersion: 2 });
        assert.equal(h.events.length, 0);
        assert.equal(yield* Queue.size(h.requests), 0);
      }),
    ),
  );
});
