// Pool registry for multiple backend processes. This file is the entry
// point for the concurrent-Windows+WSL-backend feature; see the design
// notes below before extending it.
//
// Current state (foundation commit):
//   - The existing `DesktopBackendManager` still owns the singleton
//     Windows backend lifecycle. All current consumers (window/wsl IPC,
//     lifecycle hooks, telemetry) continue to depend on that service
//     directly — nothing has migrated yet.
//   - This pool exposes the running backend under PRIMARY_INSTANCE_ID by
//     wrapping the existing manager methods. The wrapper introduces no
//     behavior change; it exists so follow-up commits can migrate
//     consumers off `DesktopBackendManager.DesktopBackendManager` onto
//     `pool.get(id)` / `pool.primary` one at a time without breaking the
//     intermediate states.
//
// Target state (concurrent Windows + WSL):
//   - `DesktopBackendManager` is reshaped from a service into an instance
//     factory parameterized by `DesktopBackendStartConfig` + an instance
//     id, returning a `DesktopBackendInstance` directly.
//   - The pool layer constructs N instances at startup — at minimum the
//     Windows primary; the WSL instance is added when the user enables
//     WSL backend mode (with the selected distro).
//   - Singleton state currently held in `DesktopState.backendReady` and
//     `DesktopBackendOutputLog` migrates onto each `DesktopBackendInstance`
//     so per-backend readiness/logging is observable independently.
//   - `getLocalEnvironmentBootstrap()` widens to
//     `getLocalEnvironmentBootstraps()` returning one bootstrap per pool
//     instance; the frontend env runtime registers each as a local
//     environment.
//   - The WSL "swap" IPC is replaced by `enableWslBackend()` +
//     `setWslBackendDistro()` controlling which (if any) WSL instance the
//     pool holds. No more swap-mode, no more rollback-on-restart.
//
// Migration sequence (each step is its own commit):
//   1. (this commit) Establish types + pool wrapper. No consumer changes.
//   2. Reshape `DesktopBackendManager` from a service singleton to an
//      instance factory. Pool layer calls it once for the Windows primary.
//      Move per-instance state (active run, restart fiber, ready, config)
//      onto the returned instance.
//   3. Per-instance readiness: drop `DesktopState.backendReady`. UI
//      subscribes to `pool.primary.snapshot.ready` (or the multi-instance
//      readiness signal once it exists).
//   4. Per-instance log routing: split `DesktopBackendOutputLog` into a
//      factory keyed by instance id.
//   5. Add `DesktopBackendInstance.create({ id, config })` to the pool so
//      the WSL backend can be registered on demand.
//   6. Wire WSL distro startup through the pool; remove `setWslBackend`
//      mode-swap IPC in favor of `enableWslBackend` / `setWslDistro`.
//   7. Widen `getLocalEnvironmentBootstrap` → `*Bootstraps`; frontend
//      runtime registers each pool instance as a local environment.
//   8. Drop the swap dialog + the "mode" appSetting. Settings UI gets a
//      "WSL backend enabled + distro" pair instead.

import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

// Opaque identifier for one backend process inside the pool. Today only
// `PRIMARY_INSTANCE_ID` is registered. Follow-up commits add WSL distros
// under ids derived from the distro name (e.g. "wsl:ubuntu"). Eventually
// these map 1:1 with environment ids on the frontend; keeping them
// desktop-local for now avoids leaking the contracts dependency into the
// pool while the migration is mid-flight.
export type BackendInstanceId = string & Brand.Brand<"BackendInstanceId">;
export const BackendInstanceId = Brand.nominal<BackendInstanceId>();

// Identifier for the always-on Windows backend. Stable across pool
// lifetimes so callers can route to it without consulting the registry.
export const PRIMARY_INSTANCE_ID: BackendInstanceId = BackendInstanceId("primary");

// One pooled backend instance — same surface as the legacy
// `DesktopBackendManagerShape` so consumers can swap with a one-line
// change. The id and label give the pool registry + UI something to
// route on; the rest mirrors per-process lifecycle controls.
export interface DesktopBackendInstance {
  readonly id: BackendInstanceId;
  readonly label: string;
  readonly start: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
  readonly waitForReady: (timeout: Duration.Duration) => Effect.Effect<boolean>;
}

export interface DesktopBackendPoolShape {
  // Look up a registered instance. None when no backend with that id is
  // currently registered (e.g. WSL backend disabled).
  readonly get: (id: BackendInstanceId) => Effect.Effect<Option.Option<DesktopBackendInstance>>;
  // Snapshot of all currently-registered instances. Order is unspecified;
  // callers that need a canonical "primary first" view should sort by id.
  readonly list: Effect.Effect<readonly DesktopBackendInstance[]>;
  // Convenience accessor for the always-registered primary instance.
  // Currently equivalent to `get(PRIMARY_INSTANCE_ID)` unwrapped, but
  // exposed as a typed effect so consumers don't have to handle the
  // Option for the case that's guaranteed to be present.
  readonly primary: Effect.Effect<DesktopBackendInstance>;
}

export class DesktopBackendPool extends Context.Service<
  DesktopBackendPool,
  DesktopBackendPoolShape
>()("t3/desktop/BackendPool") {}

// Phase-1 layer: depends on `DesktopBackendManager.layer` (the current
// singleton) and exposes its surface as a single-instance pool keyed by
// PRIMARY_INSTANCE_ID. No behavior change vs the legacy service — this
// is purely additive scaffolding so consumers can migrate one at a time.
//
// Phase 2 replaces this layer with one that constructs instances by
// calling a per-instance factory (the reshaped `DesktopBackendManager`)
// directly; the wrapper goes away once nothing references the legacy
// service.
export const layer = Layer.effect(
  DesktopBackendPool,
  Effect.gen(function* () {
    const manager = yield* DesktopBackendManager.DesktopBackendManager;
    const primaryInstance: DesktopBackendInstance = {
      id: PRIMARY_INSTANCE_ID,
      label: "Windows",
      start: manager.start,
      stop: manager.stop,
      currentConfig: manager.currentConfig,
      snapshot: manager.snapshot,
      waitForReady: manager.waitForReady,
    };
    const instancesRef = yield* Ref.make<ReadonlyMap<BackendInstanceId, DesktopBackendInstance>>(
      new Map([[PRIMARY_INSTANCE_ID, primaryInstance]]),
    );
    return DesktopBackendPool.of({
      get: (id) =>
        Ref.get(instancesRef).pipe(
          Effect.map((instances) => Option.fromNullishOr(instances.get(id))),
        ),
      list: Ref.get(instancesRef).pipe(Effect.map((instances) => Array.from(instances.values()))),
      primary: Effect.succeed(primaryInstance),
    });
  }),
);

// Test layer for unit tests that want to assert against a known pool
// composition without standing up the full manager. Each provided
// instance is registered under its own id; the first one is also
// surfaced as `primary` so callers can stub a single-instance pool.
export const layerTest = (
  instances: readonly DesktopBackendInstance[],
): Layer.Layer<DesktopBackendPool> =>
  Layer.effect(
    DesktopBackendPool,
    Effect.gen(function* () {
      if (instances.length === 0) {
        return yield* Effect.die("DesktopBackendPool.layerTest requires at least one instance");
      }
      const byId = new Map<BackendInstanceId, DesktopBackendInstance>(
        instances.map((instance) => [instance.id, instance] as const),
      );
      const primary = instances[0]!;
      return DesktopBackendPool.of({
        get: (id) => Effect.succeed(Option.fromNullishOr(byId.get(id))),
        list: Effect.succeed(Array.from(byId.values())),
        primary: Effect.succeed(primary),
      });
    }),
  );
