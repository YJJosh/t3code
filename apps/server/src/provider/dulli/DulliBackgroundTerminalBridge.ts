import {
  DulliBackgroundTerminalControlError,
  DulliBackgroundTerminalEvent,
  type DulliBackgroundTerminalControlInput,
  type DulliBackgroundTerminalControlResult,
} from "@t3tools/contracts";
import type { DulliBridgeFactory } from "@t3tools/provider-dulli/server";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Service from "./DulliBackgroundTerminals.ts";

const PREFIX = "pi-background-terminals:event:v1:";
const decode = Schema.decodeUnknownSync(DulliBackgroundTerminalEvent);
const isControlError = Schema.is(DulliBackgroundTerminalControlError);
const decodeNotification = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DulliBackgroundTerminalEvent),
);
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeFactory = Effect.gen(function* () {
  const service = yield* Service.DulliBackgroundTerminals;
  const factory: DulliBridgeFactory = Effect.fn("DulliBackgroundTerminalBridge.makeBridge")(
    function* (context) {
      let token: symbol | null = null;
      let managerId: string | null = null;
      let sequence = 0;
      const running = new Set<string>();
      const pending = new Map<
        string,
        Deferred.Deferred<DulliBackgroundTerminalControlResult, DulliBackgroundTerminalControlError>
      >();
      const error = (message: string) => new DulliBackgroundTerminalControlError({ message });
      const reset = Effect.fn("DulliBackgroundTerminalBridge.reset")(function* () {
        managerId = `dulli-session-${yield* randomUuidV4}`;
        sequence = 1;
        running.clear();
        return decode({
          contractVersion: 1,
          managerId,
          sequence: 1,
          timestamp: DateTime.formatIso(yield* DateTime.now),
          kind: "snapshot",
          snapshot: { terminals: [], replay: true },
        });
      });
      const control = Effect.fn("DulliBackgroundTerminalBridge.control")(
        function* (input: DulliBackgroundTerminalControlInput) {
          if (token === null) return yield* error("The Dulli session has stopped.");
          if (input.action !== "replay" && input.managerId !== managerId) {
            return yield* error("The selected terminal belongs to a stale Dulli process.");
          }
          // Unknown slash commands are model prompts in Pi. Never send private
          // commands unless this live session advertises the extension.
          const discovered = yield* context.rpc.request({ type: "get_commands" });
          const commands =
            typeof discovered === "object" && discovered !== null && "commands" in discovered
              ? discovered.commands
              : null;
          if (
            !Array.isArray(commands) ||
            !commands.some(
              (command: unknown) =>
                typeof command === "object" &&
                command !== null &&
                "name" in command &&
                command.name === "background-terminals-rpc",
            )
          ) {
            return yield* error(
              "The background-terminal control extension is not installed in this Dulli session.",
            );
          }
          const requestId = input.requestId ?? `t3-${yield* randomUuidV4}`;
          if (pending.has(requestId))
            return yield* error("This background-terminal request is already pending.");
          if (pending.size >= 64)
            return yield* error("Too many pending background-terminal controls.");
          const envelope = {
            action: input.action,
            request_id: requestId,
            ...("terminalId" in input ? { terminal_id: input.terminalId } : {}),
            ...("clientId" in input ? { client_id: input.clientId } : {}),
            ...(input.action === "send" ? { data: input.data } : {}),
            ...(input.action === "resize" ? { cols: input.cols, rows: input.rows } : {}),
            ...(input.action === "start"
              ? {
                  command: input.command,
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
                  ...(input.keepOpen !== undefined ? { keep_open: input.keepOpen } : {}),
                  ...(input.cols !== undefined ? { cols: input.cols } : {}),
                  ...(input.rows !== undefined ? { rows: input.rows } : {}),
                }
              : {}),
          };
          const waiter = yield* Deferred.make<
            DulliBackgroundTerminalControlResult,
            DulliBackgroundTerminalControlError
          >();
          pending.set(requestId, waiter);
          const result = yield* Effect.gen(function* () {
            yield* context.rpc.request({
              type: "prompt",
              message: `/background-terminals-rpc ${yield* encodeEnvelope(envelope)}`,
            });
            return yield* Deferred.await(waiter);
          }).pipe(
            Effect.timeout("12 seconds"),
            Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
          );
          if (result.action !== input.action || !result.success)
            return yield* error(result.error ?? "Dulli rejected the background-terminal control.");
        },
        Effect.mapError((cause) =>
          isControlError(cause) ? cause : error("Background-terminal control failed or timed out."),
        ),
      );
      const stop = Effect.fn("DulliBackgroundTerminalBridge.stop")(function* () {
        const current = token;
        token = null;
        for (const waiter of pending.values())
          yield* Deferred.fail(waiter, error("The Dulli session stopped."));
        pending.clear();
        if (current !== null) yield* service.unregister(context.threadId, current, yield* reset());
      });
      yield* Effect.addFinalizer(stop);
      return {
        onStart: Effect.fn("DulliBackgroundTerminalBridge.onStart")(function* () {
          token = yield* service.register(
            context.threadId,
            { instanceId: context.instanceId, providerSessionId: context.providerSessionId },
            control,
          );
          yield* service.publish(context.threadId, token, yield* reset());
        }),
        onStop: stop,
        hasPendingBackgroundWork: () => running.size > 0,
        notify: [
          {
            prefix: PREFIX,
            // Terminal notifications include high-frequency output chunks.
            handle: Effect.fnUntraced(function* (payload) {
              const event = yield* decodeNotification(payload).pipe(Effect.option);
              if (event._tag === "None" || token === null) return;
              const value = event.value;
              if (managerId !== null && managerId !== value.managerId && value.kind !== "snapshot")
                return;
              if (managerId === value.managerId && value.sequence <= sequence) return;
              managerId = value.managerId;
              sequence = value.sequence;
              if (value.kind === "snapshot") {
                running.clear();
                for (const terminal of value.snapshot.terminals)
                  if (terminal.status === "running") running.add(terminal.id);
              } else if (value.kind === "terminal_upsert") {
                if (value.view.status === "running") running.add(value.terminalId);
                else running.delete(value.terminalId);
              } else if (value.kind === "terminal_removed") running.delete(value.terminalId);
              if (value.kind === "control_result" && value.control.requestId) {
                const waiter = pending.get(value.control.requestId);
                if (waiter) yield* Deferred.succeed(waiter, value.control);
              }
              yield* service.publish(context.threadId, token, value);
            }),
          },
        ],
      };
    },
  );
  return factory;
});
