import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  discoverPiModels,
  discoverPiModelsWithSdk,
  piModelCapabilities,
  toServerProviderModel,
} from "./piModelDiscovery.ts";

const encodeStringLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));

describe("piModelCapabilities", () => {
  it("returns empty capabilities for non-reasoning models", () => {
    expect(piModelCapabilities({ id: "gpt-x", provider: "openai", reasoning: false })).toEqual({
      optionDescriptors: [],
    });
  });

  it("treats thinkingLevelMap as partial overrides instead of a complete allowlist", () => {
    const capabilities = piModelCapabilities({
      id: "claude-fable-5",
      provider: "claude-agent-sdk",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
    });
    const descriptor = capabilities.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("reasoning");
    expect(descriptor?.type).toBe("select");
    const optionIds = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
    expect(optionIds).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("excludes normal levels explicitly mapped to null", () => {
    const capabilities = piModelCapabilities({
      id: "kimi-k2.7-code",
      provider: "opencode-go",
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null },
    });
    const descriptor = capabilities.optionDescriptors?.[0];
    const optionIds = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
    expect(optionIds).toEqual(["off", "high"]);
  });

  it("does not advertise extended thinking levels without explicit mappings", () => {
    const capabilities = piModelCapabilities({ id: "o1", provider: "openai", reasoning: true });
    const descriptor = capabilities.optionDescriptors?.[0];
    const optionIds = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
    expect(optionIds).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("defaults reasoning to high for every Pi model provider when no selection exists", () => {
    for (const provider of ["openai-codex", "claude-agent-sdk", "opencode-go"]) {
      const capabilities = piModelCapabilities({
        id: "reasoning-model",
        provider,
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, max: "max" },
      });
      const descriptor = capabilities.optionDescriptors?.find(
        (option) => option.id === "reasoning",
      );

      expect(descriptor).toMatchObject({
        type: "select",
        currentValue: "high",
        options: expect.arrayContaining([{ id: "high", label: "high", isDefault: true }]),
      });
    }
  });

  it("advertises the context-window choices reported by the /context command", () => {
    const capabilities = piModelCapabilities(
      {
        id: "gpt-6.1-sol",
        provider: "openai-codex",
        contextWindow: 272_000,
        contextWindowChoices: [872_000, 128_000, 272_000, 500_000, 1_048_576],
      },
      { contextCommandAvailable: true },
    );
    const descriptor = capabilities.optionDescriptors?.find(
      (option) => option.id === "contextWindow",
    );
    expect(descriptor).toMatchObject({
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "auto", label: "Auto (272K)", isDefault: true },
        { id: "128k", label: "128K" },
        { id: "272k", label: "272K" },
        { id: "500k", label: "500K" },
        { id: "872k", label: "872K" },
        { id: "1048576", label: "1.05M" },
      ],
    });
  });

  it("only offers windows up to the default when /context does not report choices", () => {
    const capabilities = piModelCapabilities(
      { id: "gpt-5.6-sol", provider: "openai-codex", contextWindow: 272_000 },
      { contextCommandAvailable: true },
    );
    const descriptor = capabilities.optionDescriptors?.find(
      (option) => option.id === "contextWindow",
    );
    const optionIds = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
    expect(optionIds).toEqual(["auto", "128k", "200k", "256k", "272k"]);
  });

  it("does not advertise context-window controls without the /context extension command", () => {
    const capabilities = piModelCapabilities(
      { id: "gpt-x", provider: "custom", contextWindow: 200_000 },
      { contextCommandAvailable: false },
    );
    expect(capabilities.optionDescriptors?.some((option) => option.id === "contextWindow")).toBe(
      false,
    );
  });

  it("advertises Standard and Fast service tiers for supported OpenAI Codex models", () => {
    const capabilities = piModelCapabilities(
      {
        id: "gpt-5.5",
        provider: "openai-codex",
        reasoning: true,
      },
      { codexFastCommandAvailable: true },
    );
    const descriptor = capabilities.optionDescriptors?.find(
      (option) => option.id === "serviceTier",
    );
    expect(descriptor).toMatchObject({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
    });
  });

  it("requires the selected Pi profile to load the /fast extension command", () => {
    const capabilities = piModelCapabilities(
      { id: "gpt-5.5", provider: "openai-codex", reasoning: true },
      { codexFastCommandAvailable: false },
    );
    expect(capabilities.optionDescriptors?.some((option) => option.id === "serviceTier")).toBe(
      false,
    );
  });

  it.each(["gpt-5.4-mini", "gpt-6-astra"])("does not advertise Fast service for %s", (id) => {
    const capabilities = piModelCapabilities(
      {
        id,
        provider: "openai-codex",
        reasoning: true,
      },
      { codexFastCommandAvailable: true },
    );
    expect(capabilities.optionDescriptors?.some((option) => option.id === "serviceTier")).toBe(
      false,
    );
  });
});

describe("discoverPiModelsWithSdk", () => {
  it("exposes Fast only when the loaded profile registers the command", async () => {
    const result = await discoverPiModelsWithSdk({
      createAgentSessionServices: async () => ({
        modelRuntime: {
          getAvailable: async () => [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              provider: "openai-codex",
              reasoning: true,
            },
          ],
          getError: () => undefined,
        },
        resourceLoader: {
          getExtensions: () => ({
            extensions: [{ commands: new Map([["fast", {}]]) }],
          }),
        },
        diagnostics: [],
      }),
    });

    expect(result.models[0]?.capabilities?.optionDescriptors).toContainEqual(
      expect.objectContaining({ id: "serviceTier", label: "Service Tier" }),
    );
  });

  it("exposes context controls when the loaded profile registers the command", async () => {
    const result = await discoverPiModelsWithSdk({
      createAgentSessionServices: async () => ({
        modelRuntime: {
          getAvailable: async () => [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              provider: "openai-codex",
              contextWindow: 272_000,
            },
          ],
          getError: () => undefined,
        },
        resourceLoader: {
          getExtensions: () => ({
            extensions: [{ commands: new Map([["context", {}]]) }],
          }),
        },
        diagnostics: [],
      }),
    });

    expect(result.models[0]?.capabilities?.optionDescriptors).toContainEqual(
      expect.objectContaining({ id: "contextWindow", label: "Context Window" }),
    );
  });

  it("asks the /context command for each model's context-window choices", async () => {
    const result = await discoverPiModelsWithSdk({
      createAgentSessionServices: async () => ({
        modelRuntime: {
          getAvailable: async () => [
            { id: "gpt-6.1-sol", provider: "openai-codex", contextWindow: 272_000 },
            { id: "gpt-5.5", provider: "openai-codex", contextWindow: 272_000 },
          ],
          getError: () => undefined,
        },
        resourceLoader: {
          getExtensions: () => ({
            extensions: [
              {
                commands: new Map([
                  [
                    "context",
                    {
                      contextWindowChoices: (model: { id: string }) => {
                        if (model.id === "gpt-5.5") throw new Error("unexpected model");
                        return [272_000, 500_000, 872_000];
                      },
                    },
                  ],
                ]),
              },
            ],
          }),
        },
        diagnostics: [],
      }),
    });

    const contextOptionIds = (index: number) => {
      const descriptor = result.models[index]?.capabilities?.optionDescriptors?.find(
        (option) => option.id === "contextWindow",
      );
      return descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
    };
    expect(contextOptionIds(0)).toEqual(["auto", "272k", "500k", "872k"]);
    // A failing hook falls back to lowering-only choices instead of failing discovery.
    expect(contextOptionIds(1)).toEqual(["auto", "128k", "200k", "256k", "272k"]);
  });

  it("exposes provider-scoped extension commands, prompts, and skills", async () => {
    const userSource = {
      path: "/home/user/.pi/agent/resources/item",
      scope: "user" as const,
    };
    const projectSource = {
      path: "/workspace/.pi/resources/item",
      scope: "project" as const,
    };
    const result = await discoverPiModelsWithSdk({
      createAgentSessionServices: async () => ({
        modelRuntime: {
          getAvailable: async () => [],
          getError: () => undefined,
        },
        resourceLoader: {
          getExtensions: () => ({
            extensions: [
              {
                commands: new Map([
                  ["review", { description: "Review the change", sourceInfo: userSource }],
                  ["pm", { description: "pm", sourceInfo: userSource }],
                  ["pm-subagents", { description: "pm-subagents", sourceInfo: userSource }],
                  ["config-set", { description: "config-set", sourceInfo: userSource }],
                  ["judge", { description: "judge", sourceInfo: userSource }],
                  ["mcp", { description: "mcp", sourceInfo: userSource }],
                  ["subagents-rpc", { description: "Private subagent control" }],
                  ["background-terminals-rpc", { description: "Private terminal control" }],
                  ["project-only", { sourceInfo: projectSource }],
                ]),
              },
            ],
          }),
          getPrompts: () => ({
            prompts: [
              {
                name: "fix-tests",
                description: "Fix focused tests",
                argumentHint: "[test path]",
                sourceInfo: userSource,
              },
            ],
          }),
          getSkills: () => ({
            skills: [
              {
                name: "brave-search",
                description: "Search the web",
                filePath: "/home/user/.pi/agent/skills/brave-search/SKILL.md",
                sourceInfo: userSource,
              },
              {
                name: "project-skill",
                description: "Project only",
                filePath: "/workspace/.pi/skills/project-skill/SKILL.md",
                sourceInfo: projectSource,
              },
            ],
          }),
        },
        diagnostics: [],
      }),
    });

    expect(result.slashCommands).toEqual([
      { name: "review", description: "Review the change" },
      ...["pm", "pm-subagents", "config-set", "judge", "mcp"].map((name) => ({
        name,
        description: name,
      })),
      {
        name: "fix-tests",
        description: "Fix focused tests",
        input: { hint: "[test path]" },
      },
    ]);
    expect(result.skills).toEqual([
      {
        name: "brave-search",
        description: "Search the web",
        shortDescription: "Search the web",
        path: "/home/user/.pi/agent/skills/brave-search/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it.effect("loads extensions with the instance environment in an isolated worker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const variableName = `T3_PI_MODEL_DISCOVERY_ENV_TEST_${NodeCrypto.randomUUID().replaceAll("-", "_")}`;
      const commandName = "instance-environment-test";
      const previous = process.env[variableName];
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-pi-model-discovery-",
      });
      yield* fileSystem.makeDirectory(path.join(agentDir, "extensions"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(agentDir, "extensions", "environment-test.ts"),
        `export default function (pi) {
  if (process.env.${variableName} === "instance-secret") {
    pi.registerCommand("${commandName}", {
      description: "Loaded from the instance environment",
      handler: async () => {},
    });
  }
}\n`,
      );
      const result = yield* discoverPiModels({
        agentDir,
        environment: { ...process.env, [variableName]: "instance-secret" },
      });

      expect(result.error).toBeUndefined();
      expect(result.slashCommands).toContainEqual({
        name: commandName,
        description: "Loaded from the instance environment",
      });
      expect(process.env[variableName]).toBe(previous);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shares normalized agent paths with extensions and discovers the current catalog", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-path-discovery-" });
      const agentDir = paths.join(home, "agent");
      yield* fileSystem.makeDirectory(paths.join(agentDir, "extensions"), { recursive: true });
      yield* fileSystem.writeFileString(
        paths.join(agentDir, "extensions", "normalized-path.ts"),
        `export default function (pi) {
  if (process.env.PI_CODING_AGENT_DIR === ${encodeStringLiteral(agentDir)}) {
    pi.registerCommand("normalized-path", { handler: async () => {} });
  }
}\n`,
      );
      const environment = {
        HOME: home,
        TAU_CODING_AGENT_DIR: "~/agent",
        PI_OFFLINE: "1",
        // Discovery checks configured auth presence; it never sends a model request.
        OPENAI_API_KEY: "t3-discovery-fixture-not-a-credential",
      };
      for (const configuredAgentDir of [undefined, "~/agent"]) {
        const result = yield* discoverPiModels({
          agentDir: configuredAgentDir,
          cwd: home,
          environment,
        });
        expect(result.error).toBeUndefined();
        expect(result.slashCommands).toContainEqual({ name: "normalized-path" });
        expect(result.models).toContainEqual(
          expect.objectContaining({ slug: "openai/gpt-6-astra" }),
        );
      }
      expect(environment).not.toHaveProperty("PI_CODING_AGENT_DIR");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads context-window choices from the /context extension in the worker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-pi-context-discovery-",
      });
      const agentDir = paths.join(home, "agent");
      yield* fileSystem.makeDirectory(paths.join(agentDir, "extensions"), { recursive: true });
      yield* fileSystem.writeFileString(
        paths.join(agentDir, "extensions", "context.ts"),
        `export default function (pi) {
  const command = {
    handler: async () => {},
    contextWindowChoices: (model) =>
      model.id === "gpt-6-astra" ? [128000, model.contextWindow, 500000, 872000] : undefined,
  };
  pi.registerCommand("context", command);
}\n`,
      );
      const result = yield* discoverPiModels({
        agentDir,
        cwd: home,
        environment: {
          HOME: home,
          PI_OFFLINE: "1",
          OPENAI_API_KEY: "t3-discovery-fixture-not-a-credential",
        },
      });

      expect(result.error).toBeUndefined();
      const astra = result.models.find((model) => model.slug === "openai/gpt-6-astra");
      const descriptor = astra?.capabilities?.optionDescriptors?.find(
        (option) => option.id === "contextWindow",
      );
      const optionIds = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
      expect(optionIds).toEqual(["auto", "128k", "272k", "500k", "872k"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers models without inheriting the parent Node watch and IPC channel", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-watch-discovery-" });
      const agentDir = paths.join(home, "agent");
      yield* fileSystem.makeDirectory(paths.join(agentDir, "extensions"), { recursive: true });
      yield* fileSystem.writeFileString(
        paths.join(agentDir, "extensions", "watch-environment.ts"),
        `export default function (pi) {
  if (process.env.WATCH_REPORT_DEPENDENCIES === undefined &&
      process.env.NODE_CHANNEL_FD === undefined &&
      process.env.NODE_CHANNEL_SERIALIZATION_MODE === undefined) {
    pi.registerCommand("isolated-watch-environment", { handler: async () => {} });
  }
}\n`,
      );
      const environment = {
        HOME: home,
        PI_OFFLINE: "1",
        OPENAI_API_KEY: "t3-discovery-fixture-not-a-credential",
        WATCH_REPORT_DEPENDENCIES: "1",
        NODE_CHANNEL_FD: "3",
        NODE_CHANNEL_SERIALIZATION_MODE: "json",
      };
      const originalEnvironment = { ...environment };
      const result = yield* discoverPiModels({ agentDir, cwd: home, environment });

      expect(result.error).toBeUndefined();
      expect(result.auth).toEqual({ status: "authenticated" });
      expect(result.models).toContainEqual(expect.objectContaining({ slug: "openai/gpt-6-astra" }));
      expect(result.slashCommands).toContainEqual({ name: "isolated-watch-environment" });
      expect(environment).toEqual(originalEnvironment);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Writes a Pi package under `<modulesDir>/@earendil-works/pi-coding-agent`
  // and returns its CLI.
  const writeFakePiPackage = Effect.fn(function* (modulesDir: string, sdkSource: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const packageDir = paths.join(modulesDir, "@earendil-works", "pi-coding-agent");
    yield* fileSystem.makeDirectory(paths.join(packageDir, "dist", "bundle"), { recursive: true });
    yield* fileSystem.writeFileString(
      paths.join(packageDir, "package.json"),
      `{"name":"@earendil-works/pi-coding-agent","type":"module",
"exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}}`,
    );
    yield* fileSystem.writeFileString(paths.join(packageDir, "dist", "index.js"), sdkSource);
    yield* fileSystem.writeFileString(
      paths.join(packageDir, "dist", "bundle", "package.json"),
      '{"type":"module"}',
    );
    const cli = paths.join(packageDir, "dist", "bundle", "cli.js");
    yield* fileSystem.writeFileString(cli, "#!/usr/bin/env node\n");
    yield* fileSystem.chmod(cli, 0o755);
    return cli;
  });

  // Mirrors an npm/nvm global install: `bin/pi` links into the package's CLI.
  const writeFakePiInstall = Effect.fn(function* (root: string, sdkSource: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const cli = yield* writeFakePiPackage(paths.join(root, "lib", "node_modules"), sdkSource);
    yield* fileSystem.makeDirectory(paths.join(root, "bin"));
    const bin = paths.join(root, "bin", "pi");
    yield* fileSystem.symlink(cli, bin);
    return bin;
  });

  const installedSdkSource = `export async function createAgentSessionServices() {
  return {
    modelRuntime: {
      getAvailable: async () => [{ id: "claude-opus-5-5", provider: "claude-agent-sdk" }],
      getError: () => undefined,
    },
    diagnostics: [],
  };
}\n`;

  it.effect("discovers with the SDK of the Pi install that sessions launch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-installed-sdk-" });
      const binaryPath = yield* writeFakePiInstall(root, installedSdkSource);
      const result = yield* discoverPiModels({
        binaryPath,
        cwd: root,
        environment: { HOME: root, PI_OFFLINE: "1" },
      });

      expect(result.error).toBeUndefined();
      expect(result.models.map((model) => model.slug)).toEqual([
        "claude-agent-sdk/claude-opus-5-5",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Mirrors Pi's installer: a linked `<agent dir>/bin/pi` script runs the
  // release named in `install/current-version`.
  it.effect("discovers with the SDK of Pi's managed install", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-managed-sdk-" });
      const agentDir = paths.join(root, "agent");
      const releases = paths.join(agentDir, "install", "releases");
      yield* writeFakePiPackage(
        paths.join(releases, "1.0.4", "node_modules"),
        "export const version = '1.0.4';\n",
      );
      yield* writeFakePiPackage(paths.join(releases, "1.1.0", "node_modules"), installedSdkSource);
      yield* fileSystem.writeFileString(
        paths.join(agentDir, "install", "current-version"),
        "1.1.0\n",
      );
      yield* fileSystem.makeDirectory(paths.join(agentDir, "bin"));
      const launcher = paths.join(agentDir, "bin", "pi");
      yield* fileSystem.writeFileString(launcher, "#!/bin/sh\n");
      yield* fileSystem.chmod(launcher, 0o755);
      yield* fileSystem.makeDirectory(paths.join(root, "local-bin"));
      const binaryPath = paths.join(root, "local-bin", "pi");
      yield* fileSystem.symlink(launcher, binaryPath);

      const result = yield* discoverPiModels({
        binaryPath,
        cwd: root,
        environment: { HOME: root, PI_OFFLINE: "1" },
      });

      expect(result.error).toBeUndefined();
      expect(result.models.map((model) => model.slug)).toEqual([
        "claude-agent-sdk/claude-opus-5-5",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the bundled SDK when the installed Pi lacks the discovery API", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-legacy-sdk-" });
      const binaryPath = yield* writeFakePiInstall(root, "export const version = '0.1.0';\n");
      yield* fileSystem.makeDirectory(paths.join(root, "agent"));
      const result = yield* discoverPiModels({
        binaryPath,
        agentDir: paths.join(root, "agent"),
        cwd: root,
        environment: {
          HOME: root,
          PI_OFFLINE: "1",
          OPENAI_API_KEY: "t3-discovery-fixture-not-a-credential",
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.models).toContainEqual(expect.objectContaining({ slug: "openai/gpt-6-astra" }));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves the diagnostic when the discovery worker cannot start", () =>
    Effect.gen(function* () {
      const result = yield* discoverPiModels({
        environment: { NODE_OPTIONS: "--t3-pi-invalid-worker-option" },
      });

      expect(result.auth).toEqual({ status: "unknown" });
      expect(result.models).toEqual([]);
      expect(result.error).toContain("--t3-pi-invalid-worker-option");
      expect(result.error).not.toBe("[object Object]");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("loads extension-registered providers before enumerating available models", async () => {
    let receivedOptions:
      | Parameters<Parameters<typeof discoverPiModelsWithSdk>[0]["createAgentSessionServices"]>[0]
      | undefined;
    const result = await discoverPiModelsWithSdk(
      {
        createAgentSessionServices: async (options) => {
          receivedOptions = options;
          return {
            modelRuntime: {
              getAvailable: async () => [
                {
                  id: "claude-sonnet-5",
                  name: "Claude Sonnet 5",
                  provider: "claude-agent-sdk",
                  reasoning: true,
                },
              ],
              getError: () => undefined,
            },
            diagnostics: [],
          };
        },
      },
      { agentDir: "/tmp/pi-agent", cwd: "/tmp/project", profile: "coder" },
    );

    expect(result).toMatchObject({
      auth: { status: "authenticated" },
      models: [
        {
          slug: "claude-agent-sdk/claude-sonnet-5",
          subProvider: "claude-agent-sdk",
        },
      ],
    });
    expect(receivedOptions).toMatchObject({
      agentDir: "/tmp/pi-agent",
      cwd: "/tmp/project",
      resourceLoaderOptions: {
        noSkills: false,
        noPromptTemplates: false,
        noThemes: true,
        noContextFiles: true,
      },
    });
    const extensionFlagValues = receivedOptions?.extensionFlagValues;
    expect(extensionFlagValues).toBeInstanceOf(Map);
    expect((extensionFlagValues as Map<string, boolean | string>).get("profile")).toBe("coder");
  });
});

describe("toServerProviderModel", () => {
  it("builds a provider/id slug and preserves the display name", () => {
    expect(
      toServerProviderModel({
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        provider: "anthropic",
      }),
    ).toMatchObject({
      slug: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      subProvider: "anthropic",
      isCustom: false,
    });
  });

  it("falls back to the slug when no name is provided", () => {
    expect(toServerProviderModel({ id: "gpt-5", provider: "openai" }).name).toBe("openai/gpt-5");
  });
});
