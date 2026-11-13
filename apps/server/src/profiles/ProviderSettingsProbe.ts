import { mergeClaudeProcessEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  ClaudeSettings,
  CodexSettings,
  ProfilesError,
  type ProviderSettingsOptions,
  type ProfileProviderSettingsDriver,
} from "@t3tools/contracts";
import { PiSettings } from "@t3tools/provider-pi/settings";
import { detectPiProfileOptions } from "@t3tools/provider-pi/server";
import { probeClaudeCapabilities } from "../provider/ClaudeProvider.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";

const decodeClaude = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownEffect(CodexSettings);
const decodePi = Schema.decodeUnknownEffect(PiSettings);

export class ProviderSettingsProbe extends Context.Service<
  ProviderSettingsProbe,
  {
    readonly run: (input: {
      readonly driver: ProfileProviderSettingsDriver;
      readonly config: unknown;
      readonly environment: NodeJS.ProcessEnv;
      readonly cwd: string;
    }) => Effect.Effect<ProviderSettingsOptions, ProfilesError>;
  }
>()("t3/profiles/ProviderSettingsProbe") {}

const make = Effect.gen(function* () {
  const services = yield* Effect.context<
    | Effect.Services<ReturnType<typeof withCodexAppServerClient>>
    | Effect.Services<ReturnType<typeof probeClaudeCapabilities>>
    | Effect.Services<ReturnType<typeof detectPiProfileOptions>>
  >();
  const run = Effect.fn("ProviderSettingsProbe.run")(
    function* (input: {
      readonly driver: ProfileProviderSettingsDriver;
      readonly config: unknown;
      readonly environment: NodeJS.ProcessEnv;
      readonly cwd: string;
    }) {
      switch (input.driver) {
        case "claudeAgent": {
          const settings = yield* decodeClaude(input.config);
          yield* probeClaudeCapabilities(
            settings,
            yield* mergeClaudeProcessEnvironment(settings, undefined, input.environment),
            input.cwd,
            false,
          );
          return {
            claudeAgent: {
              tools: [],
              // Initialization commands do not distinguish skills from built-in slash commands.
              skills: [],
              plugins: [],
            },
          };
        }
        case "pi":
          return {
            pi: yield* detectPiProfileOptions(
              yield* decodePi(input.config),
              input.environment,
              input.cwd,
            ),
          };
        case "codex": {
          const settings = yield* decodeCodex(input.config);
          const { client } = yield* withCodexAppServerClient({
            binaryPath: settings.binaryPath,
            homePath: settings.homePath,
            launchArgs: settings.launchArgs,
            cwd: input.cwd,
            environment: input.environment,
          });
          const features: NonNullable<ProviderSettingsOptions["codex"]>["features"][number][] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = yield* client.request("experimentalFeature/list", {
              limit: 100,
              ...(cursor === undefined ? {} : { cursor }),
            });
            features.push(
              ...result.data.map((feature) => ({
                name: feature.name,
                enabled: feature.enabled,
                ...(feature.description == null ? {} : { description: feature.description }),
              })),
            );
            cursor = result.nextCursor ?? undefined;
            if (cursor === undefined) break;
          }
          const skills = yield* client.request("skills/list", { cwds: [input.cwd] });
          const plugins = yield* client.request("plugin/list", { cwds: [input.cwd] });
          return {
            codex: {
              features,
              skills: skills.data.flatMap((entry) =>
                entry.skills.map((skill) => ({
                  name: skill.name,
                  description: skill.description,
                  enabled: skill.enabled,
                })),
              ),
              plugins: plugins.marketplaces.flatMap((marketplace) =>
                marketplace.plugins.map((plugin) => ({ name: plugin.id, enabled: plugin.enabled })),
              ),
              error:
                "Per-thread skill and plugin disabling is not verified for Codex; disabledSkills and disabledPlugins are not applied.",
            },
          };
        }
      }
    },
    Effect.scoped,
    Effect.provide(services),
    Effect.timeout("30 seconds"),
    Effect.mapError(
      () =>
        new ProfilesError({
          reason: "unavailable",
          message:
            "Provider settings discovery failed or timed out. Check the enabled provider's installation and configuration.",
        }),
    ),
  );
  return ProviderSettingsProbe.of({ run });
});
export const layer = Layer.effect(ProviderSettingsProbe, make);
