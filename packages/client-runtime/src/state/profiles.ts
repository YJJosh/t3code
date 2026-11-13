import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

type EnvironmentAtomFamily = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: Record<string, never>;
}) => Atom.Atom<unknown>;

/** `catalog` is the server config query the profile pickers read, refreshed after every change. */
export function createProfilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: { readonly catalog: EnvironmentAtomFamily },
) {
  const { catalog } = options;
  const editor = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:profiles:editor",
    tag: WS_METHODS.profilesEditorRead,
  });
  /** Bumped after a change made through T3, so the mounted sync copies it to the other environments. */
  const localChangeAtom = Atom.make<{
    readonly count: number;
    readonly environmentId: EnvironmentId | null;
  }>({ count: 0, environmentId: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel("profiles:local-change"),
  );
  const changed = (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() => {
      registry.refresh(editor({ environmentId, input: {} }));
      registry.refresh(catalog({ environmentId, input: {} }));
      registry.update(localChangeAtom, ({ count }) => ({ count: count + 1, environmentId }));
    });
  const copied = (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() => {
      registry.refresh(editor({ environmentId, input: {} }));
      registry.refresh(catalog({ environmentId, input: {} }));
    });
  const detectOptions = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:profiles:detect-options",
    tag: WS_METHODS.profilesDetectOptions,
    // Detecting starts provider probes on the environment; reuse an answer for a while.
    staleTimeMs: 5 * 60_000,
  });
  return {
    editor,
    detectOptions,
    clearClaudeList: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:profiles:claude-list-clear",
      tag: WS_METHODS.profilesClearClaudeList,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(detectOptions({ environmentId, input: {} }))),
    }),
    localChangeAtom,
    writeEditor: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:profiles:editor-write",
      tag: WS_METHODS.profilesEditorWrite,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) => changed(environmentId, registry),
    }),
    runSkills: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:profiles:skills",
      tag: WS_METHODS.profilesSkills,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) => changed(environmentId, registry),
    }),
    readSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:profiles:sync-read",
      tag: WS_METHODS.profilesSyncRead,
    }),
    writeSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:profiles:sync-write",
      tag: WS_METHODS.profilesSyncWrite,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) => copied(environmentId, registry),
    }),
    markSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:profiles:sync-mark",
      tag: WS_METHODS.profilesSyncMark,
    }),
  };
}

export type ProfilesEnvironmentAtoms = ReturnType<typeof createProfilesEnvironmentAtoms>;
