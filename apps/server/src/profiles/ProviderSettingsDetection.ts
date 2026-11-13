import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ProfilesError,
  defaultInstanceIdForDriver,
  type ProviderSettingsOptions,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ClaudeSessionInventory from "../provider/ClaudeSessionInventory.ts";
import * as ProviderSettingsProbe from "./ProviderSettingsProbe.ts";

export class ProviderSettingsDetection extends Context.Service<
  ProviderSettingsDetection,
  {
    readonly detect: () => Effect.Effect<ProviderSettingsOptions, ProfilesError>;
    /** Forgets what Claude sessions reported for the instance `detect` shows; new sessions refill it. */
    readonly clearClaudeList: () => Effect.Effect<void>;
  }
>()("t3/profiles/ProviderSettingsDetection") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const probe = yield* ProviderSettingsProbe.ProviderSettingsProbe;
  const inventory = yield* ClaudeSessionInventory.ClaudeSessionInventory;
  const secrets = yield* SecretResolver.SecretResolver;
  const hostEnvironment = yield* HostProcess.Environment;
  const selectInstance = Effect.fn("ProviderSettingsDetection.selectInstance")(function* (
    driver: "claudeAgent" | "codex" | "pi",
  ) {
    const candidates = (yield* registry.listInstances).filter(
      (instance) => instance.enabled && instance.driverKind === driver,
    );
    return (
      candidates.find(
        (instance) => instance.instanceId === defaultInstanceIdForDriver(instance.driverKind),
      ) ?? candidates[0]
    );
  });
  const detect = Effect.fn("ProviderSettingsDetection.detect")(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () => new ProfilesError({ reason: "io", message: "Could not read provider settings." }),
      ),
    );
    const options: ProviderSettingsOptions = {};
    for (const driver of ["claudeAgent", "codex", "pi"] as const) {
      const selected = yield* selectInstance(driver);
      if (!selected) continue;
      // Claude's startup probe cannot list tools, plugins or skills; only real sessions report them.
      if (driver === "claudeAgent") {
        const recorded = yield* inventory.get(selected.instanceId);
        Object.assign(options, {
          claudeAgent: {
            tools: (recorded?.tools ?? []).map((name) => ({ name })),
            plugins: (recorded?.plugins ?? []).map((name) => ({ name })),
            skills: (recorded?.skills ?? []).map((name) => ({ name })),
            ...(recorded === undefined
              ? {
                  error:
                    "Start one Claude thread on this machine, then Refresh, to list Claude's tools and plugins.",
                }
              : {}),
          },
        });
        continue;
      }
      const entry = current.providerInstances[selected.instanceId];
      const result = yield* Effect.gen(function* () {
        const variables = entry?.environment ?? [];
        const values = yield* secrets.read(
          variables.flatMap((variable) =>
            typeof variable.value === "string" ? [] : [variable.value],
          ),
        );
        let index = 0;
        const resolved = [];
        for (const variable of variables) {
          const value = typeof variable.value === "string" ? variable.value : values[index++];
          if (value === undefined)
            return yield* new ProfilesError({
              reason: "unavailable",
              message: "A provider environment secret is unavailable.",
            });
          resolved.push({ ...variable, value });
        }
        const environment = yield* mergeProviderInstanceEnvironment(resolved, hostEnvironment);
        return yield* probe.run({
          driver,
          config: entry?.config ?? {},
          environment,
          cwd: config.cwd,
        });
      }).pipe(Effect.result);
      if (result._tag === "Success") Object.assign(options, result.success);
      else {
        const error =
          "Provider settings discovery failed or timed out. Check this provider's installation and configuration.";
        Object.assign(
          options,
          driver === "codex"
            ? { codex: { features: [], skills: [], plugins: [], error } }
            : { pi: { skills: [], promptTemplates: [], error } },
        );
      }
    }
    return options;
  });
  const clearClaudeList = Effect.fn("ProviderSettingsDetection.clearClaudeList")(function* () {
    const selected = yield* selectInstance("claudeAgent");
    if (selected) yield* inventory.clear(selected.instanceId);
  });
  return ProviderSettingsDetection.of({ detect, clearClaudeList });
});
export const layer = Layer.effect(ProviderSettingsDetection, make);
