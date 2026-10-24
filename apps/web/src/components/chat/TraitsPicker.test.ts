import { describe, expect, it } from "vite-plus/test";
import { type ProviderOptionDescriptor } from "@t3tools/contracts";
import { filterTraitsDescriptors, mergeScopedProviderOptions } from "./TraitsPicker";
function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

describe("Dulli scoped configuration", () => {
  it("orders home before profile and preserves unrelated selected traits on edits", () => {
    const profile = selectDescriptor("profile", [{ id: "coder", label: "Coder" }], "coder");
    const home = selectDescriptor("configSet", [{ id: "work", label: "Work" }], "work");
    const reasoning = selectDescriptor("reasoning", [{ id: "high", label: "High" }], "high");
    expect(filterTraitsDescriptors([reasoning, profile, home], "pi-configuration")).toEqual([
      home,
      profile,
    ]);
    expect(filterTraitsDescriptors([reasoning, profile, home], "pi-other")).toEqual([reasoning]);
    expect(
      mergeScopedProviderOptions(
        [
          { id: "profile", value: "old" },
          { id: "reasoning", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
        [home, profile],
      ),
    ).toEqual([
      { id: "reasoning", value: "high" },
      { id: "serviceTier", value: "priority" },
      { id: "configSet", value: "work" },
      { id: "profile", value: "coder" },
    ]);
  });
});
