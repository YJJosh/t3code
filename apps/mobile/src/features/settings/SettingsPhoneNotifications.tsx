import { useRef, useState } from "react";
import { Linking } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import {
  openPhoneBatterySettings,
  phoneNotificationsEnabled,
  setPhoneNotificationsEnabled,
  supportsPhoneNotifications,
} from "../agent-awareness/androidNotifications";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";

function batterySettings() {
  try {
    openPhoneBatterySettings();
  } catch {
    void Linking.openSettings();
  }
}

export function SettingsPhoneNotifications() {
  const [enabled, setEnabled] = useState(phoneNotificationsEnabled);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const available = supportsPhoneNotifications();

  async function applyToggle(next: boolean) {
    try {
      if (next) {
        const permission = await runtime.runPromise(requestAgentNotificationPermission);
        if (permission.type !== "granted") {
          Dialog.alert(
            "Notification permission needed",
            "Allow notifications in Android Settings, then try again.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Settings", onPress: () => void Linking.openSettings() },
            ],
          );
          return;
        }
      }
      setPhoneNotificationsEnabled(next);
      setEnabled(next);
      if (next) {
        Dialog.alert(
          "Allow background connection?",
          "For timely notifications with the screen off, allow Dulli to run without battery optimization. Your server and tailnet must remain reachable.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Battery settings", onPress: batterySettings },
          ],
        );
      }
    } catch (error) {
      setEnabled(phoneNotificationsEnabled());
      Dialog.alert(
        "Couldn't update notifications",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function toggle(next: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    // Promise.finally instead of try/finally: the React Compiler cannot lower a finally clause.
    void applyToggle(next).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }

  return (
    <SettingsScreen title="Notifications">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
      >
        <SettingsSection title="Paired servers">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Background phone notifications"
            subtitle={
              available
                ? "Stay connected to your own servers for approvals, questions and finished turns. Shows a persistent Dulli connected notification."
                : "Install a newer Dulli Android app to enable background notifications."
            }
            value={enabled}
            disabled={!available || busy}
            onValueChange={toggle}
          />
          {enabled ? (
            <SettingsRow
              icon="bolt.circle"
              label="Battery optimization"
              onPress={batterySettings}
            />
          ) : null}
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
