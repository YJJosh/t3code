import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

import { resolveMobileBrandName } from "./mobileBranding";

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  const osMajorVersion = Number.parseInt(Device.osVersion?.split(".")[0] ?? "", 10);
  const deviceModel = Device.modelName?.trim();

  return {
    label: `${resolveMobileBrandName(Constants.expoConfig?.extra?.appBrand)} Mobile`,
    deviceType:
      Device.deviceType === Device.DeviceType.TABLET
        ? "tablet"
        : Device.deviceType === Device.DeviceType.PHONE
          ? "mobile"
          : "unknown",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
    ...(Number.isFinite(osMajorVersion) && osMajorVersion > 0 ? { osMajorVersion } : {}),
    ...(deviceModel ? { deviceModel } : {}),
    surface: "mobile",
    ...(appVersion ? { appVersion } : {}),
  };
}
