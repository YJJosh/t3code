/**
 * Server-side Dulli bridges: each fork Pi extension integration (subagents,
 * background terminals, shared terminal sessions) adds
 * one factory to the list below. The Dulli adapter reads DulliBridgeRegistry
 * when it is constructed and runs every factory once per Pi session.
 */
import {
  DulliBridgeRegistry,
  DulliSharedEnvironment,
  type DulliBridgeFactory,
} from "@t3tools/provider-dulli/server";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as DulliSharedSessions from "./DulliSharedSessions.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DulliSubagentBridge from "./DulliSubagentBridge.ts";
import * as DulliBackgroundTerminalBridge from "./DulliBackgroundTerminalBridge.ts";
import * as DulliHtmlBridge from "./DulliHtmlBridge.ts";
import * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";

export const layer = Layer.merge(
  Layer.effect(
    DulliSharedEnvironment,
    Effect.gen(function* () {
      return yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
    }),
  ),
  Layer.effect(
    DulliBridgeRegistry,
    Effect.gen(function* () {
      const factories: ReadonlyArray<DulliBridgeFactory> = [
        yield* DulliBackgroundTerminalBridge.makeFactory,
        yield* DulliHtmlBridge.makeFactory,
        yield* DulliSubagentBridge.makeFactory,
        yield* DulliSharedSessions.makeFactory,
      ];
      return factories;
    }),
  ).pipe(Layer.provide(HtmlRender.layer.pipe(Layer.provide(PreviewBrowser.layer)))),
);
