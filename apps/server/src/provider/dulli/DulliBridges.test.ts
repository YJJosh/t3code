import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { DulliAdapterV2Driver } from "@t3tools/provider-dulli/server";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerConfig from "../../config.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as DulliBridges from "./DulliBridges.ts";
import * as BackgroundTerminals from "./DulliBackgroundTerminals.ts";
import * as Subagents from "./DulliSubagents.ts";
import * as SharedSessions from "./DulliSharedSessions.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const instanceId = ProviderInstanceId.make("dulli-wiring");
const threadId = ThreadId.make("parent-wiring");
const selection = { instanceId, model: "default" };

it.effect(
  "production bridge registry is captured by the canonical adapter and Pi subagent controls reach the live session",
  () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const requests = yield* Queue.unbounded<Record<string, unknown>>();
      const emit = (record: Record<string, unknown>) =>
        Queue.offer(stdout, new TextEncoder().encode(`${encode(record)}\n`)).pipe(Effect.asVoid);
      let buffer = "";
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(999_999_999),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            stdin: Sink.forEach((bytes: Uint8Array) =>
              Effect.gen(function* () {
                buffer += new TextDecoder().decode(bytes);
                while (buffer.includes("\n")) {
                  const end = buffer.indexOf("\n");
                  const request = yield* decode(buffer.slice(0, end)).pipe(Effect.orDie);
                  buffer = buffer.slice(end + 1);
                  yield* Queue.offer(requests, request);
                  if (typeof request.id !== "string" || request.type === "extension_ui_response")
                    continue;
                  const data =
                    request.type === "get_state"
                      ? {
                          sessionFile: "/fake/pi/wiring.jsonl",
                          isStreaming: false,
                          thinkingLevel: "high",
                        }
                      : request.type === "get_commands"
                        ? { commands: [] }
                        : request.type === "get_available_models"
                          ? { models: [] }
                          : request.type === "get_messages"
                            ? { messages: [] }
                            : request.type === "get_entries"
                              ? { entries: [] }
                              : {};
                  yield* emit({
                    type: "response",
                    id: request.id,
                    command: request.type,
                    success: true,
                    data,
                  });
                }
              }),
            ),
          }),
        ),
      );
      const instances = Layer.effect(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        Effect.gen(function* () {
          // This is the same driver-construction boundary hydration owns in server.ts.
          const adapter = yield* DulliAdapterV2Driver.create({
            instanceId,
            displayName: undefined,
            environment: [],
            enabled: true,
            config: {
              enabled: true,
              binaryPath: "pi",
              profile: "coder",
              agentDir: "/fake/pi",
              piSessions: false,
              shareWithTerminal: false,
              customModels: [],
            },
          });
          const instance: ProviderInstance = {
            instanceId,
            driverKind: adapter.driver,
            enabled: true,
            displayName: undefined,
            continuationIdentity: { driverKind: adapter.driver, continuationKey: "dulli-wiring" },
            orchestrationAdapter: adapter,
            snapshot: {} as ProviderInstance["snapshot"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          };
          return ProviderInstanceRegistry.ProviderInstanceRegistry.of({
            getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.never,
          });
        }),
      ).pipe(Layer.provide(DulliBridges.layer));
      const facade = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
        Layer.provideMerge(instances),
      );
      // Hydration captures the production factory registry, not a test-only list.
      const graph = facade.pipe(
        Layer.provide(BackgroundTerminals.layer),
        Layer.provideMerge(Subagents.layer),
        Layer.provide(SharedSessions.layer),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("wiring")),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed({ dulliRuns: [], dulliTranscript: [] } as never),
          }),
        ),
        Layer.provide(Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.succeed([]) })),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Layer.provide(Layer.succeed(HostProcess.Environment, { HOME: "/fake" })),
        Layer.provide(IdAllocator.layer),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("This registry test must not access the network.")),
          ),
        ),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "dulli-bridges-" })),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        const adapter = yield* registry.get(instanceId);
        // Runtime and MCP facade lookups return this one already-constructed adapter.
        assert.strictEqual(yield* registry.get(instanceId), adapter);
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("wiring-session"),
          modelSelection: selection,
          runtimePolicy: policy,
        });
        yield* runtime.ensureThread({
          threadId,
          modelSelection: selection,
          runtimePolicy: policy,
        });
        const controls = yield* Subagents.DulliSubagents;
        const stopError = yield* controls
          .control({
            threadId,
            taskId: "unknown-child",
            action: "stop",
          })
          .pipe(Effect.flip);
        assert.match(stopError.message, /subagent control extension is not installed/);
        // The bridge checked the installed Pi commands, rather than treating a
        // missing child as a missing live session or sending a model prompt.
        let commandQueries = 0;
        while ((yield* Queue.size(requests)) > 0) {
          const request = yield* Queue.take(requests);
          if (request.type === "get_commands") commandQueries++;
          assert.notEqual(request.type, "prompt");
        }
        assert.isAbove(commandQueries, 0);
      }).pipe(Effect.provide(graph));
    }).pipe(Effect.scoped),
);
