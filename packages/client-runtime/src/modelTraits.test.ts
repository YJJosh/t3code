import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string }>,
  currentValue: string,
): ProviderOptionDescriptor {
  return { id, label: id, type: "select", options, currentValue };
}

const defaultHome = { id: "__providerDefault", label: "Default" };
const workHome = { id: "work", label: "Work" };
const personalHome = { id: "personal", label: "Personal" };

function display(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  provider: "dulli" | "codex" = "dulli",
) {
  return buildTraitsTriggerDisplay({
    provider: ProviderDriverKind.make(provider),
    descriptors,
    primarySelectDescriptorId: "reasoning",
    ultrathinkPromptControlled: false,
  }).label;
}

describe("Dulli trait trigger", () => {
  it("omits home labels unless there are at least two concrete homes", () => {
    const profile = selectDescriptor("profile", [{ id: "coder", label: "Coder" }], "coder");
    for (const homes of [[defaultHome], [defaultHome, workHome]]) {
      expect(display([selectDescriptor("configSet", homes, homes.at(-1)!.id), profile])).toBe(
        "Coder",
      );
    }
    expect(
      display([
        selectDescriptor("configSet", [defaultHome, workHome, personalHome], "work"),
        profile,
      ]),
    ).toBe("Work · Coder");
    expect(display([selectDescriptor("configSet", [workHome], "work")], "codex")).toBe("Work");
  });

  it.each([
    ["default", "High", "Normal"],
    ["priority", "High Fast", "Fast"],
    ["ultra", "High Ultrafast", "Ultrafast"],
  ])("combines reasoning with the %s service tier", (tier, combined, standalone) => {
    const speed = selectDescriptor(
      "serviceTier",
      [
        { id: "default", label: "Normal" },
        { id: "priority", label: "Fast" },
        { id: "ultra", label: "Ultrafast" },
      ],
      tier,
    );
    const reasoning = selectDescriptor("reasoning", [{ id: "high", label: "High" }], "high");
    expect(display([speed, reasoning])).toBe(combined);
    expect(display([speed])).toBe(standalone);
  });
});
