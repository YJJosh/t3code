import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type { DulliBridgeContext } from "@t3tools/provider-dulli/server";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import { makeFactory } from "./DulliHtmlBridge.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = HtmlRender.layer.pipe(
  Layer.provide(
    Layer.mock(PreviewBrowser.PreviewBrowser)({ installed: Effect.succeed(Option.none()) }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dulli-html-" })),
  Layer.provideMerge(NodeServices.layer),
);
const harness = Effect.gen(function* () {
  const factory = yield* makeFactory;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dulli-html-source-" });
  const path = paths.join(directory, "page.html");
  yield* fs.writeFileString(path, "<h1>Visual</h1>");
  const emitted: ProviderAdapterV2Event[] = [];
  const threadId = ThreadId.make("html-calling-thread");
  let active = {
    input: {
      threadId,
      runId: "html-run",
      rootNodeId: "html-root",
      providerThread: { id: "html-provider-thread" },
    },
    providerTurn: { id: "html-provider-turn" },
  } as unknown as NonNullable<ReturnType<DulliBridgeContext["getActiveTurn"]>>;
  let running = true;
  const context = {
    threadId,
    providerSessionId: ProviderSessionId.make("html-session"),
    instanceId: ProviderInstanceId.make("dulli"),
    emit: (event: ProviderAdapterV2Event) =>
      Effect.sync(() => {
        emitted.push(event);
      }),
    // The real adapter returns a new wrapper on every call, not one stable object.
    getActiveTurn: () => (running ? { ...active } : null),
    getItemOrdinal: () => 7,
  } as unknown as DulliBridgeContext;
  const bridge = yield* factory(context);
  const envelope = { contractVersion: 1, path, title: "Visual", height: 600, toolCallId: "call-1" };
  return {
    bridge,
    emitted,
    fs,
    paths,
    directory,
    path,
    threadId,
    envelope,
    notify: (value: unknown) => bridge.notify![0]!.handle(encode(value), {}),
    stopTurn: () => {
      running = false;
    },
    wrongThread: () => {
      active = { ...active, input: { ...active.input, threadId: ThreadId.make("other") } };
    },
  };
});

it.effect(
  "publishes inline only in the calling thread, using html_render storage and local image preparation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const image = h.paths.join(h.directory, "local.png");
        yield* h.fs.writeFile(
          image,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        yield* h.fs.writeFileString(h.path, `<h1>Visual</h1><img src="${image}">`);
        expect(h.bridge.notify![0]!.prefix).toBe("pi-html-show:event:v1:");
        // A malicious threadId field cannot redirect publication.
        yield* h.notify({ ...h.envelope, threadId: "other", text: "Terminal-only table copy" });
        expect(h.emitted).toHaveLength(1);
        const event = h.emitted[0]!;
        expect(event.type).toBe("turn_item.updated");
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool") return;
        expect(event.turnItem.threadId).toBe(h.threadId);
        expect(event.turnItem.ordinal).toBe(7);
        expect(event.turnItem.runId).toBe("html-run");
        const reference = htmlRenderFromToolItem(event.turnItem);
        expect(reference).toMatchObject({ title: "Visual", height: 600 });
        const config = yield* ServerConfig.ServerConfig;
        const stored = resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: reference!.attachmentId,
        });
        const html = yield* h.fs.readFileString(stored!);
        expect(html).toContain("<h1>Visual</h1>");
        expect(html).toContain("data:image/png;base64,");
        expect(html).toContain('<style id="t3-theme">');
        expect(encode(event).length).toBeLessThan(8192);
        expect(encode(event)).not.toContain("<h1>");
        expect(encode(event)).not.toContain("Terminal-only table copy");
        expect(event.turnItem.input).toEqual({ title: "Visual", height: 600 });
        yield* h.notify(h.envelope);
        expect(h.emitted).toHaveLength(1);
        yield* h.bridge.onStop!("stopped");
        yield* h.notify({ ...h.envelope, toolCallId: "after-stop" });
        expect(h.emitted).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects invalid envelopes, missing/invalid sources, and oversized source bytes without publishing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const cases = [
          {},
          { ...h.envelope, contractVersion: 2 },
          { ...h.envelope, path: "relative.html" },
          { ...h.envelope, path: "/invalid\0.html" },
          { ...h.envelope, path: h.directory },
          { ...h.envelope, path: h.paths.join(h.directory, "missing.html") },
          { ...h.envelope, title: " " },
          { ...h.envelope, title: "x".repeat(201) },
          { ...h.envelope, height: 79 },
          { ...h.envelope, height: 2001 },
          { ...h.envelope, height: 100.5 },
        ];
        for (const [index, value] of cases.entries())
          yield* h.notify({ ...value, toolCallId: `invalid-${index}` });
        yield* h.notify({ ...h.envelope, toolCallId: "" });
        yield* h.bridge.notify![0]!.handle("not json", {});
        yield* h.bridge.notify![0]!.handle("x".repeat(8193), {});
        for (const [index, source] of ["x".repeat(512_001), "é".repeat(256_001), " "].entries()) {
          yield* h.fs.writeFileString(h.path, source);
          yield* h.notify({ ...h.envelope, toolCallId: `bad-source-${index}` });
        }
        yield* h.fs.writeFile(h.path, new Uint8Array([0xff, 0xfe]));
        yield* h.notify({ ...h.envelope, toolCallId: "invalid-utf8" });
        expect(h.emitted).toEqual([]);
        const config = yield* ServerConfig.ServerConfig;
        expect(yield* h.fs.readDirectory(config.attachmentsDir)).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("ignores notifications outside the calling active turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      h.wrongThread();
      yield* h.notify(h.envelope);
      h.stopTurn();
      yield* h.notify(h.envelope);
      expect(h.emitted).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);
