/**
 * Load the launched Pi install’s SDK lazily, falling back to the bundled SDK.
 * Use its runtime-service loader so extensions register providers before discovery.
 * List only models with configured credentials; never read or expose credentials.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A worker deadline must survive a blocked SDK import.
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
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { workerThreadEnvironment } from "./workerThreadEnvironment.ts";
import { buildSelectOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";
import { resolvePiAgentDir } from "./piPaths.ts";
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
const PRIVATE_RPC_COMMAND_NAMES = new Set(["subagents-rpc", "background-terminals-rpc"]);

/** Minimal structural view of the SDK `Model` we depend on. */
interface PiSdkModel {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Record<string, string | null> | undefined;
  readonly contextWindow?: number | undefined;
  /** Manual windows in tokens, reported by the loaded `/context` command. */
  readonly contextWindowChoices?: ReadonlyArray<number> | undefined;
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
  /** The Pi command sessions launch; its installed SDK is used for discovery. */
  readonly binaryPath?: string | undefined;
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
  /**
   * Optional `/context` hook (pi-effort-commands) listing a model's manual
   * context windows, so the menu follows the extension without T3 changes.
   */
  readonly contextWindowChoices?: ((model: PiSdkModel) => unknown) | undefined;
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
  /** SDKs tried before the one that loaded, with the reason each was skipped. */
  readonly skippedSdks?: ReadonlyArray<string> | undefined;
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
    if (!name || PRIVATE_RPC_COMMAND_NAMES.has(name)) return;
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
 * Match Pi’s partial thinking-level overrides: ordinary levels are allowed unless
 * mapped to null, but xhigh and max require explicit map entries.
 */
export interface PiModelCapabilityOptions {
  readonly codexFastCommandAvailable?: boolean | undefined;
  readonly contextCommandAvailable?: boolean | undefined;
}

// Fallback for `/context` commands without `contextWindowChoices`: any window
// up to the configured default is valid, so offer the presets below it.
const PI_CONTEXT_WINDOW_PRESETS = [
  128_000, 200_000, 256_000, 272_000, 372_000, 400_000, 1_000_000, 1_050_000,
] as const;

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
  const discoveredWindows = (model.contextWindowChoices ?? []).filter(
    (tokens) => Number.isInteger(tokens) && tokens >= 1_000,
  );
  const manualWindows = Array.from(
    new Set(
      discoveredWindows.length > 0
        ? discoveredWindows
        : [...PI_CONTEXT_WINDOW_PRESETS.filter((tokens) => tokens <= defaultWindow), defaultWindow],
    ),
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
            "Auto uses Pi's configured model limit. Manual values come from Pi's /context command and can lower it or opt into a larger supported window.",
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

/**
 * Reads the first `/context` command's `contextWindowChoices` hook. Mirrored in
 * the discovery worker source, which cannot import this module.
 */
function piContextWindowHook(resources: PiResourceSnapshot) {
  const hook = resources.extensions
    .map((extension) => extension.commands.get(PI_CONTEXT_COMMAND))
    .find((command) => command !== undefined)?.contextWindowChoices;
  return (model: PiSdkModel): ReadonlyArray<number> | undefined => {
    if (typeof hook !== "function" || typeof model.contextWindow !== "number") return undefined;
    try {
      const choices = hook({
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
      });
      return Array.isArray(choices)
        ? choices.filter((tokens): tokens is number => typeof tokens === "number")
        : undefined;
    } catch {
      return undefined;
    }
  };
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
  const resources = snapshotPiResources(services.resourceLoader);
  const contextWindowChoices = piContextWindowHook(resources);
  const available = await services.modelRuntime.getAvailable();
  return {
    available: available.map((model) => {
      const choices = contextWindowChoices(model);
      return choices ? { ...model, contextWindowChoices: choices } : model;
    }),
    resources,
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
const loadSdk = async (urls) => {
  const skippedSdks = [];
  for (const url of urls) {
    try {
      const sdk = await import(url);
      if (typeof sdk.createAgentSessionServices === "function") return { sdk, skippedSdks };
      skippedSdks.push(url + " does not export createAgentSessionServices");
    } catch (error) {
      skippedSdks.push(url + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  throw new Error("No usable Pi SDK. " + skippedSdks.join("; "));
};
(async () => {
  const { sdk, skippedSdks } = await loadSdk(workerData.sdkUrls);
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
  const contextCommand = (loader?.getExtensions().extensions ?? [])
    .map((extension) => extension.commands.get("context"))
    .find((command) => command !== undefined);
  const contextWindowChoices = (model) => {
    const hook = contextCommand?.contextWindowChoices;
    if (typeof hook !== "function" || typeof model.contextWindow !== "number") return undefined;
    try {
      const choices = hook({ provider: model.provider, id: model.id, contextWindow: model.contextWindow });
      return Array.isArray(choices) ? choices.filter((tokens) => typeof tokens === "number") : undefined;
    } catch {
      return undefined;
    }
  };
  const available = (await services.modelRuntime.getAvailable()).map((model) => {
    const choices = contextWindowChoices(model);
    return {
      id: model.id,
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      provider: model.provider,
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
      ...(choices ? { contextWindowChoices: choices } : {}),
    };
  });
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
      ...(skippedSdks.length > 0 ? { skippedSdks } : {}),
    },
  });
})().catch(sendError);
`;

function loadPiDiscoverySnapshotInWorker(
  sdkUrls: ReadonlyArray<string>,
  options: PiModelDiscoveryOptions,
): Promise<PiSdkDiscoverySnapshot> {
  return new Promise((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(PI_DISCOVERY_WORKER_SOURCE, {
      eval: true,
      env: workerThreadEnvironment(options.environment),
      workerData: {
        sdkUrls,
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

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

const PiPackageManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    main: Schema.optional(Schema.String),
    exports: Schema.optional(Schema.Unknown),
  }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function piSdkEntry(manifest: typeof PiPackageManifest.Type): string {
  const root = isRecord(manifest.exports) ? manifest.exports["."] : manifest.exports;
  if (typeof root === "string") return root;
  if (isRecord(root)) {
    const entry = root.import ?? root.default;
    if (typeof entry === "string") return entry;
  }
  return manifest.main ?? "index.js";
}

/**
 * Follow symlinked bins, npm Windows shims and managed-install launchers to the SDK.
 * Unknown installs (including compiled binaries) return undefined for bundled fallback.
 */
const resolveInstalledPiSdkUrl = Effect.fn("resolveInstalledPiSdkUrl")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv | undefined) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const readManifest = (directory: string) =>
      fs.readFileString(paths.join(directory, "package.json")).pipe(
        Effect.map(Schema.decodeUnknownOption(PiPackageManifest)),
        Effect.orElseSucceed(() => Option.none<typeof PiPackageManifest.Type>()),
      );
    const sdkUrl = (directory: string, manifest: typeof PiPackageManifest.Type) =>
      paths
        .toFileUrl(paths.join(directory, piSdkEntry(manifest)))
        .pipe(Effect.map((url) => url.href));
    const piSdkUrlAt = Effect.fn("PiModelDiscovery.piSdkUrlAt")(function* (directory: string) {
      const manifest = yield* readManifest(directory);
      return Option.isSome(manifest) && manifest.value.name === PI_SDK_PACKAGE
        ? yield* sdkUrl(directory, manifest.value)
        : undefined;
    });

    const command = yield* resolveCommandPath(binaryPath, environment ? { env: environment } : {});
    if (command === null) return undefined;
    const realCommand = yield* fs.realPath(command);
    // The first named package.json above the real bin owns it; build-output
    // manifests such as `{"type":"module"}` have no name and are skipped.
    let directory = paths.dirname(realCommand);
    while (true) {
      const manifest = yield* readManifest(directory);
      if (Option.isSome(manifest)) {
        if (manifest.value.name === PI_SDK_PACKAGE) return yield* sdkUrl(directory, manifest.value);
        break;
      }
      const parent = paths.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const shimSdkUrl = yield* piSdkUrlAt(
      paths.join(paths.dirname(command), "node_modules", PI_SDK_PACKAGE),
    );
    if (shimSdkUrl) return shimSdkUrl;
    // Pi's installer launches `<agent dir>/bin/pi`, a script that runs the
    // release named in `<agent dir>/install/current-version`.
    const managedRoot = paths.join(paths.dirname(paths.dirname(realCommand)), "install");
    const version = (yield* fs.readFileString(paths.join(managedRoot, "current-version"))).trim();
    return version
      ? yield* piSdkUrlAt(
          paths.join(managedRoot, "releases", version, "node_modules", PI_SDK_PACKAGE),
        )
      : undefined;
  },
  Effect.orElseSucceed(() => undefined),
);

class PiModelDiscoveryError extends Schema.TaggedError<PiModelDiscoveryError>()(
  "PiModelDiscoveryError",
  { cause: Schema.Defect() },
) {}

/**
 * Discover Pi models and derive auth status. SDK loading and extension execution
 * happen in a worker with the provider instance's environment, keeping those
 * overrides out of the long-lived server process.
 */
export const discoverPiModels = Effect.fn("discoverPiModels")(function* (
  options: PiModelDiscoveryOptions = {},
) {
  const paths = yield* Path.Path;
  const agentDir = resolvePiAgentDir(paths, options);
  const environment = { ...(options.environment ?? process.env), PI_CODING_AGENT_DIR: agentDir };
  const installedSdkUrl = options.binaryPath
    ? yield* resolveInstalledPiSdkUrl(options.binaryPath, options.environment)
    : undefined;
  const sdkUrls = [
    ...(installedSdkUrl ? [installedSdkUrl] : []),
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ];
  return yield* Effect.tryPromise({
    try: () => loadPiDiscoverySnapshotInWorker(sdkUrls, { ...options, agentDir, environment }),
    catch: (cause) => new PiModelDiscoveryError({ cause }),
  }).pipe(
    Effect.tap((snapshot) =>
      snapshot.skippedSdks
        ? Effect.logWarning("Pi model discovery used T3's bundled Pi SDK.", {
            skippedSdks: snapshot.skippedSdks,
          })
        : Effect.void,
    ),
    Effect.map(finishPiModelDiscovery),
    Effect.catch(({ cause }) =>
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
