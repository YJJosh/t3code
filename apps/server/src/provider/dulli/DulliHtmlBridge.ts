import { ProviderDriverKind, TurnItemId } from "@t3tools/contracts";
import type { DulliBridgeFactory } from "@t3tools/provider-dulli/server";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HtmlRender from "../../htmlRender/HtmlRender.ts";

const DRIVER = ProviderDriverKind.make("dulli");
const PREFIX = "pi-html-show:event:v1:";
const bounded = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      contractVersion: Schema.Literal(1),
      path: bounded(4096),
      title: bounded(200),
      height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(80), Schema.isLessThanOrEqualTo(2000)),
      toolCallId: bounded(256),
    }),
  ),
);

export const makeFactory = Effect.gen(function* () {
  const htmlRender = yield* HtmlRender.HtmlRender;
  const paths = yield* Path.Path;
  const factory: DulliBridgeFactory = (context) => {
    let live = true;
    let runId: string | null = null;
    const seen = new Set<string>();
    return Effect.succeed({
      onStop: () =>
        Effect.sync(() => {
          live = false;
          seen.clear();
        }),
      notify: [
        {
          prefix: PREFIX,
          handle: (payload) =>
            Effect.gen(function* () {
              // The envelope contains only a file reference, never raw HTML or image data.
              if (!live || payload.length > 8192 || new TextEncoder().encode(payload).length > 8192)
                return;
              const decoded = decode(payload);
              if (decoded._tag === "None") return;
              const input = decoded.value;
              if (!paths.isAbsolute(input.path) || input.path.includes("\0") || !input.title.trim())
                return;
              const active = context.getActiveTurn();
              if (!active || active.input.threadId !== context.threadId) return;
              if (runId !== active.input.runId) {
                runId = active.input.runId;
                seen.clear();
              }
              // Notifications may be replayed on reconnect. One render per native tool call.
              if (seen.has(input.toolCallId) || seen.size >= 256) return;
              seen.add(input.toolCallId);
              const reference = yield* htmlRender
                .publishFile({
                  threadId: context.threadId,
                  path: input.path,
                  title: input.title,
                  height: input.height,
                })
                .pipe(
                  Effect.tapError((error) =>
                    Effect.logWarning("Dulli html_show could not publish inline HTML", {
                      threadId: context.threadId,
                      path: input.path,
                      error,
                    }),
                  ),
                  Effect.option,
                );
              if (
                reference._tag === "None" ||
                !live ||
                context.getActiveTurn()?.providerTurn.id !== active.providerTurn.id
              )
                return;
              const now = yield* DateTime.now;
              // A separate item cannot be overwritten by Pi's ordinary html_show tool end.
              // html_render is the existing cross-client presentation contract, not a second tool.
              // Never forward the terminal text version: the native html_show row is title-only.
              const nativeId = `html-show:${context.providerSessionId}:${input.toolCallId}`;
              yield* context.emit({
                type: "turn_item.updated",
                driver: DRIVER,
                turnItem: {
                  id: TurnItemId.make(`dulli:${context.threadId}:${nativeId}`),
                  threadId: context.threadId,
                  runId: active.input.runId,
                  nodeId: active.input.rootNodeId,
                  providerThreadId: active.input.providerThread.id,
                  providerTurnId: active.providerTurn.id,
                  nativeItemRef: { driver: DRIVER, nativeId, strength: "strong" },
                  parentItemId: null,
                  ordinal: context.getItemOrdinal?.(nativeId) ?? 0,
                  status: "completed",
                  title: input.title,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "dynamic_tool",
                  toolName: "html_render",
                  input: { title: input.title, height: input.height },
                  output: { htmlRender: reference.value },
                },
              });
            }),
        },
      ],
    });
  };
  return factory;
});
