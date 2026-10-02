import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("keeps config set and profile together in the generic options sheet", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [
          {
            id: "configSet",
            label: "Config set",
            type: "select",
            options: [
              { id: "main", label: "main", isDefault: true },
              { id: "dev", label: "dev" },
            ],
          },
          {
            id: "profile",
            label: "Profile",
            type: "select",
            options: [
              { id: "coder", label: "coder", isDefault: true },
              { id: "research", label: "research" },
            ],
          },
        ],
      },
      selections: undefined,
    });
    expect(applyProviderOptionSelection(descriptors, { id: "configSet", value: "dev" })).toEqual([
      { id: "configSet", value: "dev" },
      { id: "profile", value: "coder" },
    ]);
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});
