import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { toStableSavedRemoteConnection } from "./connection";
import { authClientMetadata } from "./authClientMetadata";

const mobilePlatform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
const mobileDevice = vi.hoisted(() => ({
  deviceType: 1,
  DeviceType: {
    UNKNOWN: 0,
    PHONE: 1,
    TABLET: 2,
    DESKTOP: 3,
    TV: 4,
  },
  osVersion: "18.4.1",
  modelName: "iPhone 15 Pro",
}));

vi.mock("./runtime", () => ({
  runtime: {
    runPromise: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: mobilePlatform,
}));

vi.mock("expo-device", () => mobileDevice);

describe("mobile remote connection records", () => {
  afterEach(() => {
    mobilePlatform.OS = "ios";
    mobileDevice.deviceType = mobileDevice.DeviceType.PHONE;
    mobileDevice.osVersion = "18.4.1";
    mobileDevice.modelName = "iPhone 15 Pro";
  });

  it("uses the Dulli product name when the fork brand is provided", () => {
    expect(authClientMetadata(undefined, "dulli")).toMatchObject({
      label: "T3 Dulli Mobile",
      surface: "mobile",
    });
  });

  it("drops short-lived managed environment credentials from stable records", () => {
    const connection = {
      environmentId: EnvironmentId.make("environment-1"),
      environmentLabel: "Desktop",
      pairingUrl: "https://desktop.example/",
      displayUrl: "https://desktop.example/",
      httpBaseUrl: "https://desktop.example/",
      wsBaseUrl: "wss://desktop.example/",
      bearerToken: null,
      authenticationMethod: "dpop",
      dpopAccessToken: "short-lived-token",
      relayManaged: true,
    } as const;

    expect(toStableSavedRemoteConnection(connection)).not.toHaveProperty("dpopAccessToken");
  });
});
