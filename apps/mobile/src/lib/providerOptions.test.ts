import { describe, expect, it } from "vite-plus/test";

import { PI_PROFILE_OPTION_ID, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyProviderOptionSelection,
  excludeProviderOptionDescriptors,
  providerOptionValueLabels,
  resolveProviderOptionDescriptors,
} from "./providerOptions";

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
  it("summarizes the option values currently in effect", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual(["Medium", "Standard"]);
  });

  it("hides start-only options from an active thread without dropping their selections", () => {
    const allDescriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [
          ...(CODEX_CAPABILITIES.optionDescriptors ?? []),
          {
            id: PI_PROFILE_OPTION_ID,
            label: "Profile",
            type: "select",
            options: [{ id: "coder", label: "coder", isDefault: true }],
            currentValue: "coder",
          },
        ],
      },
      selections: [{ id: PI_PROFILE_OPTION_ID, value: "coder" }],
    });
    const visibleDescriptors = excludeProviderOptionDescriptors(allDescriptors, [
      PI_PROFILE_OPTION_ID,
    ]);

    expect(visibleDescriptors.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
      "serviceTier",
    ]);

    // Applying a change against the full set keeps the hidden selection.
    expect(
      applyProviderOptionSelection(allDescriptors, { id: "reasoningEffort", value: "high" }),
    ).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "default" },
      { id: PI_PROFILE_OPTION_ID, value: "coder" },
    ]);
  });

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

  it("treats an unspecified boolean capability as off", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual([]);
    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});
