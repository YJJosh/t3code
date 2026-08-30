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

it.effect("honors Pi and legacy Tau environment overrides", () =>
  Effect.gen(function* () {
    const paths = yield* Path.Path;
    expect(
      resolvePiAgentDir(paths, {
        environment: { ...ENV, PI_CODING_AGENT_DIR: "~/pi-env", TAU_CODING_AGENT_DIR: "~/tau" },
      }),
    ).toBe(paths.join(HOME, "pi-env"));
    expect(
      resolvePiAgentDir(paths, { environment: { ...ENV, TAU_CODING_AGENT_DIR: "~/tau" } }),
    ).toBe(paths.join(HOME, "tau"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("prefers an explicit configured agent dir over environment overrides", () =>
  Effect.gen(function* () {
    const paths = yield* Path.Path;
    expect(
      resolvePiAgentDir(paths, {
        agentDir: "/opt/pi/agent",
        environment: { ...ENV, PI_CODING_AGENT_DIR: "/tmp/pi-env" },
      }),
    ).toBe("/opt/pi/agent");
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
