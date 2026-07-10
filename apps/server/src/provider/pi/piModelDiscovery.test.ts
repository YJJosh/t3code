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
});

describe("discoverPiModelsWithSdk", () => {
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
