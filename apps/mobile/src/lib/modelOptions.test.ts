import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import { buildModelOptions } from "./modelOptions";

describe("mobile model options", () => {
  it("identifies the model provider behind the Pi harness", () => {
    const config = {
      providers: [
        {
          instanceId: "pi",
          driver: "pi",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "opencode-go/claude-fable-5",
              name: "Claude Fable 5",
              subProvider: "opencode-go",
              isCustom: false,
              capabilities: { optionDescriptors: [] },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(buildModelOptions(config, null)[0]).toMatchObject({
      label: "Claude Fable 5",
      subtitle: "Pi · opencode-go",
      providerDriver: "pi",
    });
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
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
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });
});
