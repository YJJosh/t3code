import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolvePiAgentDir } from "./piPaths.ts";

const HOME = "/home/pi-user";
const ENV = { HOME } satisfies NodeJS.ProcessEnv;

it.effect("defaults to ~/.pi/agent under the environment home", () =>
  Effect.gen(function* () {
    const paths = yield* Path.Path;
    expect(resolvePiAgentDir(paths, { environment: ENV })).toBe(paths.join(HOME, ".pi", "agent"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps an absolute configured agent dir as-is", () =>
  Effect.gen(function* () {
    const paths = yield* Path.Path;
    expect(resolvePiAgentDir(paths, { agentDir: "/opt/pi/agent", environment: ENV })).toBe(
      "/opt/pi/agent",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("expands ~ prefixes in a configured agent dir", () =>
  Effect.gen(function* () {
    const paths = yield* Path.Path;
    expect(resolvePiAgentDir(paths, { agentDir: "~", environment: ENV })).toBe(HOME);
    expect(resolvePiAgentDir(paths, { agentDir: "~/pi-agent", environment: ENV })).toBe(
      paths.join(HOME, "pi-agent"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
