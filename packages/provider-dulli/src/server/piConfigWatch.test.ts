import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { isPiModelConfigPath } from "./piConfigWatch.ts";

it.effect("recognizes only root model/auth/profile configuration names", () =>
  Effect.gen(function* () {
    const paths = yield* Path.Path;
    for (const name of [
      "models.json",
      "models-store.json",
      "auth.json",
      "profiles.json",
      "settings.json",
    ]) {
      expect(isPiModelConfigPath(paths, paths.join("/home/test/.pi/agent", name))).toBe(true);
    }
    expect(isPiModelConfigPath(paths, "/home/test/.pi/agent/README.md")).toBe(false);
    expect(isPiModelConfigPath(paths, "/home/test/.pi/agent/models.json.bak")).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
