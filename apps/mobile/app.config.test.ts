import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      ["APP_VARIANT", "T3CODE_MOBILE_FORK_BRAND", "T3CODE_MOBILE_FORK_VERSION"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("isolates the sideloaded Dulli APK from upstream identity, links and OTA updates", async () => {
  vi.stubEnv("T3CODE_MOBILE_FORK_BRAND", "dulli");
  vi.stubEnv("T3CODE_MOBILE_FORK_VERSION", "0.1.9-dulli.1");
  const config = await loadConfig("production");
  expect(config.name).toBe("T3 Dulli");
  expect(config.scheme).toBe("t3dulli");
  expect(config.android?.package).toBe("com.yjjosh.t3dulli");
  expect(config.version).toBe("0.1.9-dulli.1");
  expect(config.android?.versionCode).toBe(10_090_001);
  expect(config.android?.intentFilters).toEqual([]);
  expect(config.updates?.enabled).toBe(false);
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas).toBeUndefined();
  expect(config.plugins).toContainEqual([
    "./plugins/withAndroidAutolinkingExclude.cjs",
    ["expo-observe", "expo-app-metrics"],
  ]);
});
