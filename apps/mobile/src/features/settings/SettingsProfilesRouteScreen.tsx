import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ProfilesSettings } from "./ProfilesSettings";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsProfilesRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId?: EnvironmentId } | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { availableTargets, selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const requested = route.params?.environmentId;
  const environment = requested
    ? availableTargets.find((target) => target.environmentId === requested)
    : selectedTargets[0];
  return (
    <SettingsScreen title="Profiles">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <Menu
            accessibilityLabel="Profiles environment"
            actions={availableTargets.map((target) => ({
              id: target.environmentId,
              title: target.label,
              state: environment?.environmentId === target.environmentId ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent }) => {
              const target = availableTargets.find(
                (entry) => entry.environmentId === nativeEvent.event,
              );
              if (target) navigation.setParams({ environmentId: target.environmentId });
            }}
          >
            <Button
              label={environment?.label ?? "Select a connected environment"}
              disabled={availableTargets.length === 0}
              onPress={() => {}}
            />
          </Menu>
          {selectedProjectKey !== null ? (
            <Text className="text-sm text-foreground-muted">
              Profiles belong to an environment, not a project.
            </Text>
          ) : null}
        </View>
        {environment ? (
          <ProfilesSettings key={environment.environmentId} environment={environment} />
        ) : (
          <Text className="text-foreground-muted">
            {requested
              ? "This environment is not connected. Choose another environment above."
              : "Select a connected environment."}
          </Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
