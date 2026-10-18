import { describe, expect, it } from "vite-plus/test";

import { resolveDulliForkVersion } from "./dulli-fork-version";

describe("resolveDulliForkVersion", () => {
  it("derives a versionCode for Dulli releases", () => {
    expect(resolveDulliForkVersion("0.0.40-dulli.2")).toEqual({
      versionName: "0.0.40-dulli.2",
      versionCode: 400_002,
    });
    expect(resolveDulliForkVersion("0.0.40-dulli.3").versionCode).toBeGreaterThan(
      resolveDulliForkVersion("0.0.40-dulli.2").versionCode,
    );
    expect(resolveDulliForkVersion("0.0.41-dulli.0").versionCode).toBeGreaterThan(
      resolveDulliForkVersion("0.0.40-dulli.9999").versionCode,
    );
  });

  it("increases across upstream minor and patch releases", () => {
    const versions = ["0.0.45-dulli.9", "0.1.0-dulli.1", "0.1.1-dulli.0", "0.2.0-dulli.0"];
    const codes = versions.map((version) => resolveDulliForkVersion(version).versionCode);
    expect(codes).toEqual([450_009, 10_000_001, 10_010_000, 20_000_000]);
    for (let index = 1; index < codes.length; index += 1) {
      expect(codes[index]).toBeGreaterThan(codes[index - 1]!);
    }
    expect(resolveDulliForkVersion("0.210.0-dulli.0").versionCode).toBe(2_100_000_000);
    expect(resolveDulliForkVersion("0.209.999-dulli.9999").versionCode).toBe(2_099_999_999);
  });

  it("preserves legacy pi versionCodes and upgrades across the suffix transition", () => {
    expect(resolveDulliForkVersion("0.0.40-pi.1").versionCode).toBe(400_001);
    expect(resolveDulliForkVersion("0.0.40-pi.1").versionCode).toBeGreaterThan(
      resolveDulliForkVersion("0.0.36-pi.2").versionCode,
    );
    expect(resolveDulliForkVersion("0.0.40-dulli.2").versionCode).toBeGreaterThan(
      resolveDulliForkVersion("0.0.40-pi.1").versionCode,
    );
    expect(resolveDulliForkVersion("0.0.31-pi.4")).toEqual({
      versionName: "0.0.31-pi.4",
      versionCode: 310_004,
    });
    expect(resolveDulliForkVersion("0.0.32-pi.0").versionCode).toBeGreaterThan(
      resolveDulliForkVersion("0.0.31-pi.9999").versionCode,
    );
  });

  it.each([
    undefined,
    "",
    "0.0.40-beta.1",
    "1.0.0-dulli.1",
    "0.01.0-dulli.1",
    "0.0.40-dulli.01",
    "0.0.040-dulli.1",
    "0.0.40-dulli.1+build",
    "0.0.31-pi.04",
    "0.0.031-pi.4",
  ])("rejects a non-canonical release version (%s)", (version) => {
    expect(() => resolveDulliForkVersion(version)).toThrow();
  });

  it.each([
    "0.0.1000-dulli.1",
    "0.210.0-dulli.1",
    "0.999999999999999999999.0-dulli.1",
    "0.0.40-dulli.10000",
    "0.0.36-pi.10000",
  ])("rejects versions that exceed the Android versionCode slots (%s)", (version) => {
    expect(() => resolveDulliForkVersion(version)).toThrow("Cannot derive an Android versionCode");
  });
});
