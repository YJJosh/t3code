import { describe, expect, it } from "vite-plus/test";

import { resolveDulliForkVersion } from "./dulli-fork-version";

describe("resolveDulliForkVersion", () => {
  it("derives a monotonic versionCode for the pi release sequence", () => {
    expect(resolveDulliForkVersion("0.0.31-pi.4")).toEqual({
      versionName: "0.0.31-pi.4",
      versionCode: 310_004,
    });
    expect(resolveDulliForkVersion("0.0.32-pi.0").versionCode).toBeGreaterThan(
      resolveDulliForkVersion("0.0.31-pi.9999").versionCode,
    );
  });

  it.each([undefined, "", "0.0.31-beta.4", "0.0.31-pi.04", "0.0.031-pi.4"])(
    "rejects a non-canonical release version (%s)",
    (version) => {
      expect(() => resolveDulliForkVersion(version)).toThrow();
    },
  );
});
