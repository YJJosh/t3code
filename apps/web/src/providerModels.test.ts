import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderRuntimeModeToggle } from "./providerModels";

describe("getProviderRuntimeModeToggle", () => {
  it("hides runtime access modes for Pi snapshots from older servers", () => {
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("pi"),
      }),
    ).toBe(false);
  });

  it("honors explicit provider capabilities", () => {
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("pi"),
        showRuntimeModeToggle: true,
      }),
    ).toBe(true);
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("codex"),
        showRuntimeModeToggle: false,
      }),
    ).toBe(false);
  });

  it("shows runtime access modes for other or unresolved providers", () => {
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("codex"),
      }),
    ).toBe(true);
    expect(getProviderRuntimeModeToggle(null)).toBe(true);
  });
});
