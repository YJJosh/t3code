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
import { PI_THINKING_LEVELS, PI_THINKING_OPTION_ID } from "./piRpcProtocol.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

/** Minimal structural view of the SDK `Model` we depend on. */
interface PiSdkModel {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Record<string, string | null> | undefined;
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
export function piModelCapabilities(model: PiSdkModel): ModelCapabilities {
  if (model.reasoning !== true) {
    return EMPTY_CAPABILITIES;
  }
  const levels = PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  if (levels.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: PI_THINKING_OPTION_ID,
        label: "Thinking",
        options: levels.map((level) => ({ value: level, label: level })),
      }),
    ],
  });
}

export function toServerProviderModel(model: PiSdkModel): ServerProviderModel {
  const slug = piModelSlug(model);
  return {
    slug,
    name: model.name?.trim() || slug,
    subProvider: model.provider,
    isCustom: false,
    capabilities: piModelCapabilities(model),
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
  const models = available.map(toServerProviderModel);
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
