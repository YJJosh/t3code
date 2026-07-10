/**
 * Pi model discovery + auth status via the `@earendil-works/pi-coding-agent`
 * SDK.
 *
 * Uses `ModelRegistry` + `AuthStorage` directly (not the CLI) so discovery is
 * fast and does not shell out. `ModelRegistry.getAvailable()` returns only
 * models with configured credentials. T3 uses that list both for presentation
 * and auth status so unavailable built-ins do not flood the model picker.
 * Credentials themselves are never read or exposed.
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

function piModelSlug(model: PiSdkModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Build capabilities for a Pi model, annotating a `reasoning` (thinking-level)
 * select for reasoning-capable models. Levels are taken from the model's
 * `thinkingLevelMap` (dropping `null`/unsupported entries) and fall back to the
 * full Pi thinking-level set.
 */
export function piModelCapabilities(model: PiSdkModel): ModelCapabilities {
  if (model.reasoning !== true) {
    return EMPTY_CAPABILITIES;
  }
  const mappedLevels = model.thinkingLevelMap
    ? Object.entries(model.thinkingLevelMap)
        .filter(([, value]) => value !== null)
        .map(([level]) => level)
    : [];
  const levels = (mappedLevels.length > 0 ? mappedLevels : [...PI_THINKING_LEVELS]).filter(
    (level) => (PI_THINKING_LEVELS as ReadonlyArray<string>).includes(level),
  );
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

/**
 * Discover Pi models and derive auth status. Never throws — a failed SDK load
 * degrades to an empty model list with an `unknown` auth status and an `error`
 * message the probe can surface.
 */
export const discoverPiModels = Effect.fn("discoverPiModels")(function* (options?: {
  readonly agentDir?: string | undefined;
}) {
  return yield* Effect.tryPromise({
    try: async (): Promise<PiModelDiscoveryResult> => {
      const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as {
        AuthStorage: { create: (authPath?: string) => unknown };
        ModelRegistry: { create: (authStorage: unknown, modelsJsonPath?: string) => unknown };
      };
      const agentDir = options?.agentDir?.trim();
      const authPath = agentDir ? `${agentDir.replace(/\/$/, "")}/auth.json` : undefined;
      const modelsJsonPath = agentDir ? `${agentDir.replace(/\/$/, "")}/models.json` : undefined;
      const authStorage = sdk.AuthStorage.create(authPath);
      const registry = sdk.ModelRegistry.create(authStorage, modelsJsonPath) as {
        getAvailable: () => ReadonlyArray<PiSdkModel>;
        getError: () => string | undefined;
      };
      const available = registry.getAvailable();
      const models = available.map(toServerProviderModel);
      const loadError = registry.getError();
      const auth: ServerProviderAuth =
        available.length > 0 ? { status: "authenticated" } : { status: "unauthenticated" };
      return loadError ? { models, auth, error: loadError } : { models, auth };
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
