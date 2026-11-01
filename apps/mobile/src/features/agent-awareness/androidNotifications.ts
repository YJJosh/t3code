import type { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { phoneConnections } from "./phoneConnections";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";

interface AndroidAgentNotifications {
  phoneNotificationsEnabled?(): boolean;
  setPhoneNotificationsEnabled?(enabled: boolean): void;
  configurePhoneConnections?(connections: string, scheme: string): void;
  openPhoneBatterySettings?(): void;
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(deviceId, userId, appScheme(), ongoingEnabled);
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}

export function supportsPhoneNotifications(): boolean {
  return (
    Constants.expoConfig?.extra?.appBrand === "dulli" &&
    typeof native?.setPhoneNotificationsEnabled === "function"
  );
}

export function phoneNotificationsEnabled(): boolean {
  return supportsPhoneNotifications() && native?.phoneNotificationsEnabled?.() === true;
}

export function setPhoneNotificationsEnabled(enabled: boolean): void {
  if (!supportsPhoneNotifications())
    throw new Error("Install a newer Dulli Android app to enable phone notifications.");
  native?.setPhoneNotificationsEnabled?.(enabled);
}

export function configurePhoneConnections(document: ConnectionCatalogDocument): void {
  if (supportsPhoneNotifications()) {
    native?.configurePhoneConnections?.(JSON.stringify(phoneConnections(document)), appScheme());
  }
}

export function openPhoneBatterySettings(): void {
  native?.openPhoneBatterySettings?.();
}
