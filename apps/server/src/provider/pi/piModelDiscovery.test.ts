import { describe, expect, it } from "@effect/vitest";

import { piModelCapabilities, toServerProviderModel } from "./piModelDiscovery.ts";

describe("piModelCapabilities", () => {
  it("returns empty capabilities for non-reasoning models", () => {
    expect(piModelCapabilities({ id: "gpt-x", provider: "openai", reasoning: false })).toEqual({
      optionDescriptors: [],
    });
  });

  it("annotates a thinking-level select for reasoning models using thinkingLevelMap", () => {
    const capabilities = piModelCapabilities({
      id: "claude-sonnet-5",
      provider: "anthropic",
      reasoning: true,
      thinkingLevelMap: { low: "1024", high: "8192", off: null },
    });
    const descriptor = capabilities.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("reasoning");
    expect(descriptor?.type).toBe("select");
    // `off` maps to null (unsupported) and is dropped.
    const optionIds = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
    expect(optionIds).toEqual(["low", "high"]);
  });

  it("falls back to the full thinking-level set when no map is present", () => {
    const capabilities = piModelCapabilities({ id: "o1", provider: "openai", reasoning: true });
    const descriptor = capabilities.optionDescriptors?.[0];
    const optionIds = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];
    expect(optionIds).toContain("high");
    expect(optionIds).toContain("xhigh");
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
