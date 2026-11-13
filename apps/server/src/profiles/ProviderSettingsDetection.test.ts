import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ProfilesError, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderSettingsDetection from "./ProviderSettingsDetection.ts";
import * as ProviderSettingsProbe from "./ProviderSettingsProbe.ts";

it.effect("detects only enabled defaults and preserves other drivers when one probe fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const called: Array<{ driver: string; config: unknown }> = [];
    const instances = [
      ["codex-other", "codex", true],
      ["codex", "codex", true],
      ["claudeAgent", "claudeAgent", true],
      ["pi", "pi", false],
    ] as const;
    const result = yield* Effect.gen(function* () {
      return yield* (yield* ProviderSettingsDetection.ProviderSettingsDetection).detect();
    }).pipe(
      Effect.provide(
        ProviderSettingsDetection.layer.pipe(
          Layer.provide([
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  config: { binaryPath: "selected-codex" },
                },
                [ProviderInstanceId.make("codex-other")]: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  config: { binaryPath: "other-codex" },
                },
              },
            }),
            ServerConfig.layerTest(root, root),
            Layer.mock(SecretResolver.SecretResolver)({ read: () => Effect.succeed([]) }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              // Only identity and enabled status cross this external registry boundary.
              listInstances: Effect.succeed(
                instances.map(
                  ([id, driver, enabled]) =>
                    ({
                      instanceId: ProviderInstanceId.make(id),
                      driverKind: ProviderDriverKind.make(driver),
                      enabled,
                    }) as ProviderInstance,
                ),
              ),
            }),
            Layer.succeed(ProviderSettingsProbe.ProviderSettingsProbe, {
              run: (input) => {
                called.push({ driver: input.driver, config: input.config });
                return input.driver === "claudeAgent"
                  ? Effect.fail(new ProfilesError({ reason: "unavailable", message: "fixture" }))
                  : Effect.succeed({
                      codex: {
                        features: [{ name: "memories", enabled: false }],
                        skills: [],
                        plugins: [],
                      },
                    });
              },
            }),
          ]),
        ),
      ),
    );
    assert.deepEqual(
      called.map((entry) => entry.driver),
      ["claudeAgent", "codex"],
    );
    assert.deepInclude(called[1], { config: { binaryPath: "selected-codex" } });
    assert.isDefined(result.claudeAgent?.error);
    assert.deepEqual(result.codex?.features, [{ name: "memories", enabled: false }]);
    assert.isUndefined(result.pi);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
