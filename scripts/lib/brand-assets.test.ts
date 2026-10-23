import { expect, it } from "vite-plus/test";
import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  resolveWebIconOverrides,
} from "./brand-assets.ts";

it("maps Dulli web assets without changing hosted channel defaults", () => {
  expect(resolveWebIconOverrides("dulli", "dist/client")).toEqual([
    {
      sourceRelativePath: BRAND_ASSET_PATHS.dulliWebFaviconIco,
      targetRelativePath: "dist/client/favicon.ico",
    },
    {
      sourceRelativePath: BRAND_ASSET_PATHS.dulliWebFavicon16Png,
      targetRelativePath: "dist/client/favicon-16x16.png",
    },
    {
      sourceRelativePath: BRAND_ASSET_PATHS.dulliWebFavicon32Png,
      targetRelativePath: "dist/client/favicon-32x32.png",
    },
    {
      sourceRelativePath: BRAND_ASSET_PATHS.dulliWebAppleTouchIconPng,
      targetRelativePath: "dist/client/apple-touch-icon.png",
    },
  ]);
  expect(resolveWebAssetBrandForChannel("latest")).toBe("production");
});
