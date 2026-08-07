import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import { Platform } from "react-native";

import { resolveMobileBrandName } from "./mobileBranding";

export function authClientMetadata(
  appBrand: unknown = process.env.EXPO_PUBLIC_T3CODE_MOBILE_BRAND,
): AuthClientPresentationMetadata {
  return {
    label: `${resolveMobileBrandName(appBrand)} Mobile`,
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
  };
}
