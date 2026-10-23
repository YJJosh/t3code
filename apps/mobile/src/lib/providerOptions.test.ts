import { describe, expect, it } from "vite-plus/test";

import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

describe("mobile Dulli provider options", () => {
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
});
