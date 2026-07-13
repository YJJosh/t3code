import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { DEFAULT_PI_PROFILE } from "./piRpcProtocol.ts";

export interface PiProfileChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

export interface PiProfileDiscoveryOptions {
  readonly agentDir?: string | undefined;
  readonly configuredProfile?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredProfileName(value: string | undefined): string {
  return value?.trim() || DEFAULT_PI_PROFILE;
}

const RESERVED_TOP_LEVEL_PROFILE_KEYS = new Set([
  "default",
  "lastProfile",
  "profiles",
  "promptParts",
  "parts",
  "systemParts",
  "systemPromptParts",
  "mcpServers",
  "$schema",
]);

const PROFILE_CONFIG_KEYS = new Set([
  "provider",
  "model",
  "thinkingLevel",
  "tools",
  "disabledTools",
  "parts",
  "systemParts",
  "systemPromptParts",
  "promptParts",
  "appendSystemPrompt",
  "systemPrompt",
  "system",
  "skills",
  "disableProjectInputs",
  "disableProjectContext",
  "disabledProjectContextPaths",
  "disableProjectSkills",
  "mcpServers",
  "mcp",
  "agentSdk",
  "modelOverrides",
]);

function isProfileConfig(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).some((key) => PROFILE_CONFIG_KEYS.has(key));
}

function profileEntries(value: unknown): ReadonlyArray<readonly [string, unknown]> {
  if (!isRecord(value)) return [];
  if (isRecord(value.profiles)) return Object.entries(value.profiles);
  return Object.entries(value).filter(
    ([key, profile]) => !RESERVED_TOP_LEVEL_PROFILE_KEYS.has(key) && isProfileConfig(profile),
  );
}

export function parsePiProfileChoices(
  value: unknown,
  configuredProfile?: string,
): ReadonlyArray<PiProfileChoice> {
  const selectedProfile = configuredProfileName(configuredProfile);
  const choices = profileEntries(value).flatMap(([rawName, rawProfile]) => {
    const name = rawName.trim();
    if (!name || !isRecord(rawProfile)) return [];
    const description =
      typeof rawProfile.description === "string" ? rawProfile.description.trim() : "";
    return [
      {
        id: name,
        label: name,
        ...(description ? { description } : {}),
        ...(name === selectedProfile ? { isDefault: true } : {}),
      } satisfies PiProfileChoice,
    ];
  });

  if (!choices.some((choice) => choice.id === selectedProfile)) {
    choices.push({ id: selectedProfile, label: selectedProfile, isDefault: true });
  }

  return choices.sort((left, right) => left.label.localeCompare(right.label));
}

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
}

export const discoverPiProfileChoices = Effect.fn("discoverPiProfileChoices")(function* (
  options: PiProfileDiscoveryOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const environment = options.environment ?? process.env;
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    ".";
  const configuredAgentDir = options.agentDir?.trim();
  const agentDir = configuredAgentDir
    ? configuredAgentDir === "~"
      ? home
      : configuredAgentDir.startsWith("~/") || configuredAgentDir.startsWith("~\\")
        ? paths.join(home, configuredAgentDir.slice(2))
        : configuredAgentDir
    : paths.join(home, ".pi", "agent");
  const contents = yield* fileSystem
    .readFileString(paths.join(agentDir, "profiles.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  return parsePiProfileChoices(parseJson(contents), options.configuredProfile);
});
