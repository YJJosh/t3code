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
import * as NodeTimers from "node:timers";
import * as NodeWorkerThreads from "node:worker_threads";

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
  readonly environment?: NodeJS.ProcessEnv | undefined;
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

interface PiExtensionCommand {
  readonly description?: string | undefined;
  readonly sourceInfo?: PiResourceSourceInfo | undefined;
}

interface PiResourceSnapshot {
  readonly extensions: ReadonlyArray<{
    readonly commands: ReadonlyMap<string, PiExtensionCommand>;
  }>;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly filePath: string;
    readonly sourceInfo: PiResourceSourceInfo;
  }>;
  readonly prompts: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly argumentHint?: string | undefined;
    readonly sourceInfo: PiResourceSourceInfo;
  }>;
}

interface PiSdkResourceLoader {
  readonly getExtensions: () => Pick<PiResourceSnapshot, "extensions">;
  readonly getSkills?: () => Pick<PiResourceSnapshot, "skills">;
  readonly getPrompts?: () => Pick<PiResourceSnapshot, "prompts">;
}

interface PiSdkRuntimeServices {
  readonly modelRuntime: PiSdkModelRuntime;
  readonly resourceLoader?: PiSdkResourceLoader | undefined;
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

interface PiSdkDiscoverySnapshot {
  readonly available: ReadonlyArray<PiSdkModel>;
  readonly resources: PiResourceSnapshot;
  readonly diagnostics: PiSdkRuntimeServices["diagnostics"];
  readonly runtimeError?: string | undefined;
}

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

function snapshotPiResources(resourceLoader: PiSdkResourceLoader | undefined): PiResourceSnapshot {
  return {
    extensions: resourceLoader?.getExtensions().extensions ?? [],
    skills: resourceLoader?.getSkills?.().skills ?? [],
    prompts: resourceLoader?.getPrompts?.().prompts ?? [],
  };
}

function piProviderResources(resources: PiResourceSnapshot): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const commands = new Map<string, ServerProviderSlashCommand>();
  const appendCommand = (command: ServerProviderSlashCommand) => {
    const name = nonEmpty(command.name);
    if (!name) return;
    const key = name.toLowerCase();
    if (!commands.has(key)) commands.set(key, { ...command, name });
  };

  for (const extension of resources.extensions) {
    for (const [registeredName, command] of extension.commands) {
      if (!isProviderScopedResource(command.sourceInfo)) continue;
      const description = nonEmpty(command.description);
      appendCommand({
        name: registeredName,
        ...(description ? { description } : {}),
      });
    }
  }

  for (const prompt of resources.prompts) {
    if (!isProviderScopedResource(prompt.sourceInfo)) continue;
    const description = nonEmpty(prompt.description);
    const argumentHint = nonEmpty(prompt.argumentHint);
    appendCommand({
      name: prompt.name,
      ...(description ? { description } : {}),
      ...(argumentHint ? { input: { hint: argumentHint } } : {}),
    });
  }

  const skills = resources.skills.flatMap((skill) => {
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

function finishPiModelDiscovery(snapshot: PiSdkDiscoverySnapshot): PiModelDiscoveryResult {
  const extensions = snapshot.resources.extensions;
  const codexFastCommandAvailable = extensions.some((extension) =>
    extension.commands.has(PI_CODEX_FAST_COMMAND),
  );
  const contextCommandAvailable = extensions.some((extension) =>
    extension.commands.has(PI_CONTEXT_COMMAND),
  );
  const models = snapshot.available.map((model) =>
    toServerProviderModel(model, { codexFastCommandAvailable, contextCommandAvailable }),
  );
  const resources = piProviderResources(snapshot.resources);
  const errors = [
    snapshot.runtimeError,
    ...snapshot.diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => diagnostic.message),
  ].filter((message): message is string => typeof message === "string" && message.length > 0);
  const auth: ServerProviderAuth =
    snapshot.available.length > 0 ? { status: "authenticated" } : { status: "unauthenticated" };
  return errors.length > 0
    ? { models, auth, ...resources, error: errors.join("\n") }
    : { models, auth, ...resources };
}

async function loadPiDiscoverySnapshot(
  sdk: PiSdkModule,
  options: PiModelDiscoveryOptions,
): Promise<PiSdkDiscoverySnapshot> {
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
  return {
    available: await services.modelRuntime.getAvailable(),
    resources: snapshotPiResources(services.resourceLoader),
    diagnostics: services.diagnostics,
    runtimeError: services.modelRuntime.getError(),
  };
}

export async function discoverPiModelsWithSdk(
  sdk: PiSdkModule,
  options: PiModelDiscoveryOptions = {},
): Promise<PiModelDiscoveryResult> {
  return finishPiModelDiscovery(await loadPiDiscoverySnapshot(sdk, options));
}

const PI_DISCOVERY_WORKER_TIMEOUT_MS = 14_000;
const PI_DISCOVERY_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const sourceInfo = (value) => value && typeof value.path === "string" && typeof value.scope === "string"
  ? { path: value.path, scope: value.scope }
  : undefined;
const sendError = (error) => parentPort.postMessage({
  _tag: "error",
  error: error instanceof Error ? error.message : String(error),
});
(async () => {
  const sdk = await import(workerData.sdkUrl);
  const options = workerData.options;
  const services = await sdk.createAgentSessionServices({
    cwd: options.cwd,
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.profile
      ? { extensionFlagValues: new Map([["profile", options.profile]]) }
      : {}),
    resourceLoaderOptions: {
      noSkills: false,
      noPromptTemplates: false,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const loader = services.resourceLoader;
  const extensions = (loader?.getExtensions().extensions ?? []).map((extension) => ({
    commands: new Map([...extension.commands].map(([name, command]) => [name, {
      ...(typeof command.description === "string" ? { description: command.description } : {}),
      ...(sourceInfo(command.sourceInfo) ? { sourceInfo: sourceInfo(command.sourceInfo) } : {}),
    }])),
  }));
  const prompts = (loader?.getPrompts?.().prompts ?? []).map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    ...(typeof prompt.argumentHint === "string" ? { argumentHint: prompt.argumentHint } : {}),
    ...(sourceInfo(prompt.sourceInfo) ? { sourceInfo: sourceInfo(prompt.sourceInfo) } : {}),
  }));
  const skills = (loader?.getSkills?.().skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    ...(sourceInfo(skill.sourceInfo) ? { sourceInfo: sourceInfo(skill.sourceInfo) } : {}),
  }));
  const available = (await services.modelRuntime.getAvailable()).map((model) => ({
    id: model.id,
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    provider: model.provider,
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
  }));
  parentPort.postMessage({
    _tag: "success",
    snapshot: {
      available,
      resources: { extensions, prompts, skills },
      diagnostics: services.diagnostics.map((diagnostic) => ({
        type: diagnostic.type,
        message: diagnostic.message,
      })),
      ...(services.modelRuntime.getError()
        ? { runtimeError: services.modelRuntime.getError() }
        : {}),
    },
  });
})().catch(sendError);
`;

function piDiscoveryWorkerEnvironment(environment: NodeJS.ProcessEnv | undefined) {
  return Object.fromEntries(
    Object.entries(environment ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function loadPiDiscoverySnapshotInWorker(
  options: PiModelDiscoveryOptions,
): Promise<PiSdkDiscoverySnapshot> {
  return new Promise((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(PI_DISCOVERY_WORKER_SOURCE, {
      eval: true,
      env: piDiscoveryWorkerEnvironment(options.environment),
      workerData: {
        sdkUrl: import.meta.resolve("@earendil-works/pi-coding-agent"),
        options: {
          cwd: options.cwd?.trim() || process.cwd(),
          agentDir: options.agentDir?.trim() || undefined,
          profile: options.profile?.trim() || undefined,
        },
      },
    });
    let settled = false;
    // A native worker needs a hard wall even if its imported SDK never settles.
    // @effect-diagnostics-next-line globalTimers:off
    const timeout = NodeTimers.setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error("Pi SDK discovery worker timed out."));
    }, PI_DISCOVERY_WORKER_TIMEOUT_MS);
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timeout);
      void worker.terminate();
      complete();
    };
    worker.once("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("_tag" in message)) {
        settle(() => reject(new Error("Pi SDK discovery worker returned an invalid response.")));
        return;
      }
      if (message._tag === "success" && "snapshot" in message) {
        settle(() => resolve(message.snapshot as PiSdkDiscoverySnapshot));
        return;
      }
      const error = "error" in message ? String(message.error) : "Unknown worker error";
      settle(() => reject(new Error(error)));
    });
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) settle(() => reject(new Error(`Pi SDK discovery worker exited ${code}.`)));
    });
  });
}

/**
 * Discover Pi models and derive auth status. SDK loading and extension execution
 * happen in a worker with the provider instance's environment, keeping those
 * overrides out of the long-lived server process.
 */
export const discoverPiModels = Effect.fn("discoverPiModels")(function* (
  options: PiModelDiscoveryOptions = {},
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<PiModelDiscoveryResult> =>
      finishPiModelDiscovery(await loadPiDiscoverySnapshotInWorker(options)),
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
