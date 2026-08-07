import { describe, expect, it } from "vite-plus/test";

import {
  resolveMobileBrand,
  resolveMobileBrandName,
  resolveMobileBrandWord,
  resolveMobileStageLabel,
} from "./mobileBranding";

describe("mobile branding", () => {
  it("resolves Dulli presentation without changing the default brand", () => {
    expect(resolveMobileBrand("dulli")).toBe("dulli");
    expect(resolveMobileBrandName("dulli")).toBe("T3 Dulli");
    expect(resolveMobileBrandWord("dulli")).toBe("Dulli");
    expect(resolveMobileBrand(undefined)).toBe("t3code");
    expect(resolveMobileBrandName(undefined)).toBe("T3 Code");
    expect(resolveMobileBrandWord(undefined)).toBe("Code");
  });

  it.each([
    ["development", "Dev"],
    ["preview", "Nightly"],
    ["production", "Alpha"],
    [undefined, "Alpha"],
  ])("maps %s builds to %s", (appVariant, expected) => {
    expect(resolveMobileStageLabel(appVariant)).toBe(expected);
  });
});
