import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import * as PiSessionsSettlement from "./PiSessionsSettlement.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";

it.layer(NodeServices.layer)("PiSessionsSettlement", (it) => {
  it.effect("survives closing/reopening SQLite and ordinary binding writes; scopes each link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const persistence = makeSqlitePersistenceLive(`${root}/state.sqlite`);
      const layer = Layer.mergeAll(
        PiSessionsSettlement.layer,
        ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
      ).pipe(Layer.provide(persistence));
      const link = {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        sessionId: "pi",
      };
      const baseline = { daemonRev: 7, daemonSettled: true, t3Settled: true };
      yield* Effect.gen(function* () {
        const store = yield* PiSessionsSettlement.PiSessionsSettlement;
        yield* store.set(link, baseline);
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: link.threadId,
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          status: "running",
          resumeCursor: { piSessionId: "pi" },
        });
        yield* directory.upsert({
          threadId: link.threadId,
          provider: ProviderDriverKind.make("pi"),
          status: "stopped",
          runtimePayload: null,
        });
      }).pipe(Effect.provide(layer));
      // Effect.provide closes the first layer's scope, including its database connection.
      yield* Effect.gen(function* () {
        const store = yield* PiSessionsSettlement.PiSessionsSettlement;
        expect(Option.getOrThrow(yield* store.get(link))).toEqual(baseline);
        for (const other of [
          { ...link, environmentId: EnvironmentId.make("other") },
          { ...link, threadId: ThreadId.make("other") },
          { ...link, sessionId: "other" },
        ])
          expect(Option.isNone(yield* store.get(other))).toBe(true);
      }).pipe(Effect.provide(Layer.fresh(layer)));
    }).pipe(Effect.scoped),
  );
});
