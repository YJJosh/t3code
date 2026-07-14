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
  /** Present when the SDK failed to load or enumerate models. */
  readonly error?: string;
}

export interface PiModelDiscoveryOptions {
  readonly agentDir?: string | undefined;
  readonly cwd?: string | undefined;
  readonly profile?: string | undefined;
}

interface PiSdkModelRegistry {
  readonly getAvailable: () => ReadonlyArray<PiSdkModel>;
  readonly getError: () => string | undefined;
}

interface PiSdkRuntimeServices {
  readonly modelRegistry: PiSdkModelRegistry;
  readonly resourceLoader?:
    | {
        readonly getExtensions: () => {
          readonly extensions: ReadonlyArray<{
            readonly commands: ReadonlyMap<string, unknown>;
          }>;
        };
      }
    | undefined;
  readonly diagnostics: ReadonlyArray<{
    readonly type: "info" | "warning" | "error";
    readonly message: string;
  }>;
}

interface PiSdkModule {
  readonly createAgentSessionServices: (options: {
    readonly cwd: string;
    readonly agentDir?: string;
    readonly extensionFlagValues?: Map<string, boolean | string>;
    readonly resourceLoaderOptions?: {
      readonly noSkills?: boolean;
      readonly noPromptTemplates?: boolean;
      readonly noThemes?: boolean;
      readonly noContextFiles?: boolean;
    };
  }) => Promise<PiSdkRuntimeServices>;
}

function piModelSlug(model: PiSdkModel): string {
  return `${model.provider}/${model.id}`;
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
    // Provider discovery needs extensions but not the heavier prompt, skill,
    // theme, or context resources used by an actual Pi session.
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const available = services.modelRegistry.getAvailable();
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
  const errors = [
    services.modelRegistry.getError(),
    ...services.diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => diagnostic.message),
  ].filter((message): message is string => typeof message === "string" && message.length > 0);
  const auth: ServerProviderAuth =
    available.length > 0 ? { status: "authenticated" } : { status: "unauthenticated" };
  return errors.length > 0 ? { models, auth, error: errors.join("\n") } : { models, auth };
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
      const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as PiSdkModule;
      return discoverPiModelsWithSdk(sdk, options);
    },
    catch: (cause): PiModelDiscoveryResult => ({
      models: [],
      auth: { status: "unknown" },
      error: cause instanceof Error ? cause.message : String(cause),
    }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed<PiModelDiscoveryResult>({
        models: [],
        auth: { status: "unknown" },
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );
});
