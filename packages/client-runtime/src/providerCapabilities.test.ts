import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import { getProviderRuntimeModeToggle } from "./providerCapabilities.ts";

describe("getProviderRuntimeModeToggle", () => {
  it("hides runtime modes for Pi snapshots from older servers", () => {
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("pi"),
        showRuntimeModeToggle: undefined,
      }),
    ).toBe(false);
  });

  it("honors explicit provider capabilities", () => {
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("codex"),
        showRuntimeModeToggle: false,
      }),
    ).toBe(false);
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("pi"),
        showRuntimeModeToggle: true,
      }),
    ).toBe(true);
  });

  it("shows runtime modes by default for other or unavailable providers", () => {
    expect(
      getProviderRuntimeModeToggle({
        driver: ProviderDriverKind.make("codex"),
      }),
    ).toBe(true);
    expect(getProviderRuntimeModeToggle(undefined)).toBe(true);
  });
});
