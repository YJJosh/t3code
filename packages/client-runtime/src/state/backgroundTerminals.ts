import { type ThreadId, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand, followStreamInEnvironment } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { backgroundTerminalRuntimeChanges } from "../rpc/backgroundTerminals.ts";

export function createBackgroundTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const permissions = createCommandPermissions(runtime, WS_METHODS.backgroundTerminalsControl);
  const states = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return runtime
      .atom((get) =>
        followStreamInEnvironment(
          environmentId,
          backgroundTerminalRuntimeChanges(threadId, (id, _method, payload) =>
            permissions.authorize(get.registry, id, payload),
          ),
        ),
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:background-terminals:${key}`));
  });
  return {
    runtimeState: (target: { environmentId: EnvironmentId; input: { threadId: ThreadId } }) =>
      states(JSON.stringify([target.environmentId, target.input.threadId])),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:background-terminals:control",
      tag: WS_METHODS.backgroundTerminalsControl,
    }),
  };
}

export * from "./backgroundTerminalRuntime.ts";
