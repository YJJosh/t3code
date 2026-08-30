/**
 * Pi model discovery + auth status via the `@earendil-works/pi-coding-agent`
 * SDK.
 *
 * Uses Pi's SDK runtime-service loader (not CLI output parsing) so configured
 * extensions can register custom providers before
 * `ModelRegistry.getAvailable()` runs. T3 presents only models with configured
 * credentials, preventing unavailable built-ins from flooding the picker while
 * retaining extension providers such as `claude-agent-sdk`. Credentials
 * themselves are never read or exposed.
 *
 * The SDK is loaded via a dynamic import so it stays off the server's startup
 * path (discovery only runs during a provider probe).
 *
 * @module provider/pi/piModelDiscovery
 */
import type {
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import {
  PI_AUTO_CONTEXT_WINDOW,
  PI_CODEX_FAST_COMMAND,
  PI_CONTEXT_COMMAND,
  PI_CONTEXT_WINDOW_OPTION_ID,
  PI_FAST_SERVICE_TIER,
  PI_SERVICE_TIER_OPTION_ID,
  PI_STANDARD_SERVICE_TIER,
  PI_THINKING_LEVELS,
  PI_THINKING_OPTION_ID,
  supportsPiCodexFastService,
} from "./piRpcProtocol.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

/** Minimal structural view of the SDK `Model` we depend on. */
interface PiSdkModel {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Record<string, string | null> | undefined;
  readonly contextWindow?: number | undefined;
}

export interface PiModelDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly auth: ServerProviderAuth;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  /** Present when the SDK failed to load or enumerate models. */
  readonly error?: string;
}

export interface PiModelDiscoveryOptions {
  readonly agentDir?: string | undefined;
  readonly cwd?: string | undefined;
  readonly profile?: string | undefined;
}

interface PiSdkCreateAgentSessionServicesOptions {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly extensionFlagValues?: Map<string, boolean | string>;
  readonly resourceLoaderOptions?: {
    readonly noSkills?: boolean;
    readonly noPromptTemplates?: boolean;
    readonly noThemes?: boolean;
    readonly noContextFiles?: boolean;
  };
}

interface PiSdkModelRuntime {
  readonly getAvailable: () => Promise<ReadonlyArray<PiSdkModel>>;
  readonly getError: () => string | undefined;
}

interface PiResourceSourceInfo {
  readonly path: string;
  readonly scope: "user" | "project" | "temporary";
}

interface PiSdkRuntimeServices {
  readonly modelRuntime: PiSdkModelRuntime;
  readonly resourceLoader?:
    | {
        readonly getExtensions: () => {
          readonly extensions: ReadonlyArray<{
            readonly commands: ReadonlyMap<
              string,
              {
                readonly description?: string | undefined;
                readonly sourceInfo?: PiResourceSourceInfo | undefined;
              }
            >;
          }>;
        };
        readonly getSkills?: () => {
          readonly skills: ReadonlyArray<{
            readonly name: string;
            readonly description: string;
            readonly filePath: string;
            readonly sourceInfo: PiResourceSourceInfo;
          }>;
        };
        readonly getPrompts?: () => {
          readonly prompts: ReadonlyArray<{
            readonly name: string;
            readonly description: string;
            readonly argumentHint?: string | undefined;
            readonly sourceInfo: PiResourceSourceInfo;
          }>;
        };
      }
    | undefined;
  readonly diagnostics: ReadonlyArray<{
    readonly type: "info" | "warning" | "error";
    readonly message: string;
  }>;
}

export interface PiSdkModule {
  readonly createAgentSessionServices: (
    options: PiSdkCreateAgentSessionServicesOptions,
  ) => Promise<PiSdkRuntimeServices>;
}

const importPiSdk = (): Promise<unknown> =>
  // Keep discovery off startup and let focused tests run without installing Pi
  // into this shared worktree. Production installs the declared 0.84.4 package.
  Function(
    "specifier",
    "return import(specifier)",
  )("@earendil-works/pi-coding-agent") as Promise<unknown>;

function piModelSlug(model: PiSdkModel): string {
  return `${model.provider}/${model.id}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isProviderScopedResource(sourceInfo: PiResourceSourceInfo | undefined): boolean {
  return sourceInfo?.scope !== "project";
}

function piProviderResources(resourceLoader: PiSdkRuntimeServices["resourceLoader"]): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  if (!resourceLoader) return { slashCommands: [], skills: [] };

  const commands = new Map<string, ServerProviderSlashCommand>();
  const appendCommand = (command: ServerProviderSlashCommand) => {
    const name = nonEmpty(command.name);
    if (!name) return;
    const key = name.toLowerCase();
    if (!commands.has(key)) commands.set(key, { ...command, name });
  };

  for (const extension of resourceLoader.getExtensions().extensions) {
    for (const [registeredName, command] of extension.commands) {
      if (!isProviderScopedResource(command.sourceInfo)) continue;
      const description = nonEmpty(command.description);
      appendCommand({
        name: registeredName,
        ...(description ? { description } : {}),
      });
    }
  }

  for (const prompt of resourceLoader.getPrompts?.().prompts ?? []) {
    if (!isProviderScopedResource(prompt.sourceInfo)) continue;
    const description = nonEmpty(prompt.description);
    const argumentHint = nonEmpty(prompt.argumentHint);
    appendCommand({
      name: prompt.name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { input: { hint: argumentHint } } : {}),
    });
  }

  const skills = (resourceLoader.getSkills?.().skills ?? []).flatMap((skill) => {
    if (!isProviderScopedResource(skill.sourceInfo)) return [];
    const name = nonEmpty(skill.name);
    const path = nonEmpty(skill.filePath);
    if (!name || !path) return [];
    const description = nonEmpty(skill.description);
    return [
      {
        name,
        path,
        enabled: true,
        scope: skill.sourceInfo.scope,
        ...(description ? { description, shortDescription: description } : {}),
      } satisfies ServerProviderSkill,
    ];
  });

  return { slashCommands: [...commands.values()], skills };
}

/**
 * Build capabilities for a Pi model, annotating a `reasoning` (thinking-level)
 * select for reasoning-capable models. This mirrors Pi's
 * `getSupportedThinkingLevels`: its map is a partial override, not an exhaustive
 * allowlist. Normal levels are supported unless explicitly mapped to `null`;
 * extended `xhigh` and `max` levels require explicit map entries.
 */
export interface PiModelCapabilityOptions {
  readonly codexFastCommandAvailable?: boolean | undefined;
  readonly contextCommandAvailable?: boolean | undefined;
}

const PI_CONTEXT_WINDOW_PRESETS = [
  128_000, 200_000, 256_000, 272_000, 372_000, 400_000, 1_000_000, 1_050_000,
] as const;
const PI_CATALOG_CONTEXT_MAX_WINDOWS = new Map<string, number>([
  ["openai-codex/gpt-5.6-luna", 372_000],
  ["openai-codex/gpt-5.6-sol", 372_000],
  ["openai-codex/gpt-5.6-terra", 372_000],
]);

function formatContextWindowValue(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}

function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  }
  if (tokens >= 1_000) {
    return `${Number((tokens / 1_000).toFixed(1))}K`;
  }
  return String(tokens);
}

function piContextWindowChoices(model: PiSdkModel) {
  const configuredWindow = model.contextWindow;
  if (
    typeof configuredWindow !== "number" ||
    !Number.isFinite(configuredWindow) ||
    configuredWindow < 1_000
  ) {
    return [];
  }
  const defaultWindow = Math.floor(configuredWindow);
  const maximumWindow = Math.max(
    defaultWindow,
    PI_CATALOG_CONTEXT_MAX_WINDOWS.get(piModelSlug(model)) ?? defaultWindow,
  );
  const manualWindows = Array.from(
    new Set([
      ...PI_CONTEXT_WINDOW_PRESETS.filter((tokens) => tokens <= maximumWindow),
      defaultWindow,
      maximumWindow,
    ]),
  ).sort((left, right) => left - right);

  return [
    {
      value: PI_AUTO_CONTEXT_WINDOW,
      label: `Auto (${formatContextWindowLabel(defaultWindow)})`,
      isDefault: true,
    },
    ...manualWindows.map((tokens) => ({
      value: formatContextWindowValue(tokens),
      label: formatContextWindowLabel(tokens),
    })),
  ];
}

export function piModelCapabilities(
  model: PiSdkModel,
  options: PiModelCapabilityOptions = {},
): ModelCapabilities {
  const optionDescriptors = [];

  if (model.reasoning === true) {
    const levels = PI_THINKING_LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (level === "xhigh" || level === "max") return mapped !== undefined;
      return true;
    });
    if (levels.length > 0) {
      const defaultLevel = levels.includes("high") ? "high" : undefined;
      optionDescriptors.push(
        buildSelectOptionDescriptor({
          id: PI_THINKING_OPTION_ID,
          label: "Reasoning",
          options: levels.map((level) => ({
            value: level,
            label: level,
            ...(level === defaultLevel ? { isDefault: true } : {}),
          })),
        }),
      );
    }
  }

  if (options.contextCommandAvailable === true) {
    const contextWindowOptions = piContextWindowChoices(model);
    if (contextWindowOptions.length > 0) {
      optionDescriptors.push(
        buildSelectOptionDescriptor({
          id: PI_CONTEXT_WINDOW_OPTION_ID,
          label: "Context Window",
          description:
            "Auto uses Pi's configured model limit. Manual values can lower it or select a separately known catalog maximum.",
          options: contextWindowOptions,
        }),
      );
    }
  }

  if (
    options.codexFastCommandAvailable === true &&
    supportsPiCodexFastService(piModelSlug(model))
  ) {
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: PI_SERVICE_TIER_OPTION_ID,
        label: "Service Tier",
        description:
          "Fast uses OpenAI Codex priority processing for lower latency and higher usage.",
        options: [
          { value: PI_STANDARD_SERVICE_TIER, label: "Standard", isDefault: true },
          { value: PI_FAST_SERVICE_TIER, label: "Fast" },
        ],
      }),
    );
  }

  return optionDescriptors.length > 0
    ? createModelCapabilities({ optionDescriptors })
    : EMPTY_CAPABILITIES;
}

export function toServerProviderModel(
  model: PiSdkModel,
  options: PiModelCapabilityOptions = {},
): ServerProviderModel {
  const slug = piModelSlug(model);
  return {
    slug,
    name: model.name?.trim() || slug,
    subProvider: model.provider,
    isCustom: false,
    capabilities: piModelCapabilities(model, options),
  };
}

export async function discoverPiModelsWithSdk(
  sdk: PiSdkModule,
  options: PiModelDiscoveryOptions = {},
): Promise<PiModelDiscoveryResult> {
  const agentDir = options.agentDir?.trim();
  const profile = options.profile?.trim();
  const services = await sdk.createAgentSessionServices({
    cwd: options.cwd?.trim() || process.cwd(),
    ...(agentDir ? { agentDir } : {}),
    ...(profile
      ? { extensionFlagValues: new Map<string, boolean | string>([["profile", profile]]) }
      : {}),
    // Commands and user-scoped skills are provider capabilities presented by
    // the composer. Themes and project context remain unnecessary here.
    resourceLoaderOptions: {
      noSkills: false,
      noPromptTemplates: false,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const available = await services.modelRuntime.getAvailable();
  const extensions = services.resourceLoader?.getExtensions().extensions ?? [];
  const codexFastCommandAvailable = extensions.some((extension) =>
    extension.commands.has(PI_CODEX_FAST_COMMAND),
  );
  const contextCommandAvailable = extensions.some((extension) =>
    extension.commands.has(PI_CONTEXT_COMMAND),
  );
  const models = available.map((model) =>
    toServerProviderModel(model, { codexFastCommandAvailable, contextCommandAvailable }),
  );
  const resources = piProviderResources(services.resourceLoader);
  const errors = [
    services.modelRuntime.getError(),
    ...services.diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => diagnostic.message),
  ].filter((message): message is string => typeof message === "string" && message.length > 0);
  const auth: ServerProviderAuth =
    available.length > 0 ? { status: "authenticated" } : { status: "unauthenticated" };
  return errors.length > 0
    ? { models, auth, ...resources, error: errors.join("\n") }
    : { models, auth, ...resources };
}

/**
 * Discover Pi models and derive auth status. Never throws — a failed SDK load
 * degrades to an empty model list with an `unknown` auth status and an `error`
 * message the probe can surface.
 */
export const discoverPiModels = Effect.fn("discoverPiModels")(function* (
  options: PiModelDiscoveryOptions = {},
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<PiModelDiscoveryResult> => {
      const sdk = (await importPiSdk()) as PiSdkModule;
      return discoverPiModelsWithSdk(sdk, options);
    },
    catch: (cause): PiModelDiscoveryResult => ({
      models: [],
      auth: { status: "unknown" },
      slashCommands: [],
      skills: [],
      error: cause instanceof Error ? cause.message : String(cause),
    }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed<PiModelDiscoveryResult>({
        models: [],
        auth: { status: "unknown" },
        slashCommands: [],
        skills: [],
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );
});
