import { describe, expect, it } from "@effect/vitest";

import {
  discoverPiModelsWithSdk,
  piModelCapabilities,
  toServerProviderModel,
} from "./piModelDiscovery.ts";

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

  it("advertises context-window choices from the configured default through the catalog max", () => {
    const capabilities = piModelCapabilities(
      {
        id: "gpt-5.6-sol",
        provider: "openai-codex",
        contextWindow: 272_000,
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
        { id: "200k", label: "200K" },
        { id: "256k", label: "256K" },
        { id: "272k", label: "272K" },
        { id: "372k", label: "372K" },
      ],
    });
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

  it("does not advertise Fast service for unsupported Codex model ids", () => {
    const capabilities = piModelCapabilities(
      {
        id: "gpt-5.4-mini",
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
        modelRegistry: {
          getAvailable: () => [
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
        modelRegistry: {
          getAvailable: () => [
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

  it("loads extension-registered providers before enumerating available models", async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const result = await discoverPiModelsWithSdk(
      {
        createAgentSessionServices: async (options) => {
          receivedOptions = options;
          return {
            modelRegistry: {
              getAvailable: () => [
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
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    const extensionFlagValues = Reflect.get(receivedOptions ?? {}, "extensionFlagValues");
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
