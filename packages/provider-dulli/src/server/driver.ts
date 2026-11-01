import { watchPiModelConfig } from "./piConfigWatch.ts";
/**
 * Pi keeps sessions, settings, extensions and auth in the user’s own ~/.pi/agent,
 * so continuation identity uses the default instance grouping.
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { DulliSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { dulliUsageReader } from "./usage.ts";
import { makePiTextGeneration } from "./textGeneration.ts";
import { DulliAdapterV2Driver, type DulliAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { buildInitialPiProviderSnapshot, checkPiProviderStatus } from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

const decodeDulliSettings = Schema.decodeSync(DulliSettings);

const DRIVER_KIND = ProviderDriverKind.make("dulli");
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});

export type DulliDriverEnv =
  | DulliAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const DulliDriver: ProviderDriver<DulliSettings, DulliDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Dulli",
    supportsMultipleInstances: true,
  },
  usage: dulliUsageReader,
  configSchema: DulliSettings,
  defaultConfig: (): DulliSettings => decodeDulliSettings({}),
  create: Effect.fn("DulliDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const { cwd } = host.paths;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies DulliSettings;
    const resolveMaintenance = () => Effect.succeed(MAINTENANCE);

    const orchestrationAdapter = yield* DulliAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Pi orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makePiTextGeneration(effectiveConfig, processEnv);

    const checkProvider = checkPiProviderStatus(effectiveConfig, processEnv, cwd).pipe(
      Effect.map(stampIdentity),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DulliSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Pi snapshot.",
            cause,
          }),
      ),
    );

    yield* watchPiModelConfig({
      agentDir: effectiveConfig.agentDir,
      environment: processEnv,
      onChange: snapshot.refresh.pipe(Effect.asVoid),
    });

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (workspaceCwd) =>
        checkPiProviderStatus(effectiveConfig, processEnv, workspaceCwd).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
