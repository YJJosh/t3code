import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { applyAndroidAutolinkingExclude } = require("./withAndroidAutolinkingExclude.cjs") as {
  readonly applyAndroidAutolinkingExclude: (contents: string, packages: string[]) => string;
};

const SETTINGS_TEMPLATE = `plugins {
  id("expo-autolinking-settings")
}
expoAutolinking.useExpoModules()

rootProject.name = 'T3 Dulli'
`;

describe("withAndroidAutolinkingExclude", () => {
  it.each(["\n", "\r\n"])(
    "excludes packages before Expo modules are resolved, once (%j)",
    (lineEnding) => {
      const once = applyAndroidAutolinkingExclude(SETTINGS_TEMPLATE, ["expo-observe"]);
      const again = applyAndroidAutolinkingExclude(once.replaceAll("\n", lineEnding), [
        "expo-observe",
        "expo-app-metrics",
      ]);

      expect(again).toContain(
        `expoAutolinking.exclude = ["expo-observe","expo-app-metrics"]\nexpoAutolinking.useExpoModules()`,
      );
      expect(again.match(/expoAutolinking\.exclude/g)).toHaveLength(1);
    },
  );

  it("fails when the template no longer resolves Expo modules", () => {
    expect(() => applyAndroidAutolinkingExclude("rootProject.name = 'x'\n", ["a"])).toThrow(
      /useExpoModules/,
    );
  });
});
