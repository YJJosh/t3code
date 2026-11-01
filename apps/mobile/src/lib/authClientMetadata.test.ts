import { describe, expect, it, vi } from "vite-plus/test";

import { authClientMetadata } from "./authClientMetadata";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-device", () => ({
  deviceType: 1,
  DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 },
  osVersion: "18.4.1",
  modelName: "iPhone 15 Pro",
}));

describe("authClientMetadata", () => {
  it("uses the Dulli product name when the fork brand is provided", () => {
    expect(authClientMetadata(undefined, "dulli")).toMatchObject({
      label: "T3 Dulli Mobile",
      surface: "mobile",
    });
  });
});
