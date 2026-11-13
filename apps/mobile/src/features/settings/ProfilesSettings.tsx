import { AuthSettingsWriteScope, type ServerSettingsPatch } from "@t3tools/contracts";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";

export function ProfilesSettings({ environment }: { environment: SettingsTarget }) {
  const environmentId = environment.environmentId;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(serverEnvironment.profileConfig({ environmentId, input: {} }));
  const save = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save profiles settings",
    reportFailure: true,
  });
  const settings = environment.serverConfig.settings;
  const catalog = query.data?.profiles ?? environment.serverConfig.profiles;
  const update = async (patch: ServerSettingsPatch) => {
    await save({ environmentId, input: { patch } });
    query.refresh();
  };
  return (
    <SettingsSection
      title={`${environment.label} profiles`}
      footer="Sync the folder with Git, then refresh. Changes apply at the next session start, not to a running session."
    >
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground">Profiles folder</Text>
        <TextInput
          accessibilityLabel="Profiles folder"
          className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          autoCapitalize="none"
          autoCorrect={false}
          editable={canWrite}
          defaultValue={settings.profilesFolder}
          placeholder={catalog?.folder ?? "<T3 home>/profiles"}
          placeholderTextColorClassName="accent-foreground-muted"
          onEndEditing={(event) => {
            void update({ profilesFolder: event.nativeEvent.text });
          }}
        />
        <Menu
          accessibilityLabel="Default profile for new threads"
          actions={[
            { id: "__folder__", title: "Folder default" },
            { id: "", title: "No profile" },
            ...Object.entries(catalog?.profiles ?? {}).map(([id, profile]) => ({
              id,
              title: id,
              subtitle: profile.warning,
              attributes: { disabled: Boolean(profile.warning) },
            })),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (canWrite)
              void update({
                defaultProfile: nativeEvent.event === "__folder__" ? null : nativeEvent.event,
              });
          }}
        >
          <Button
            tone="text"
            label={`Default profile: ${settings.defaultProfile === null ? "Folder default" : settings.defaultProfile || "No profile"}`}
            disabled={!canWrite}
            onPress={() => {}}
          />
        </Menu>
        <Button tone="text" label="Refresh profiles" onPress={query.refresh} />
        {Object.entries(catalog?.profiles ?? {}).map(([id, profile]) =>
          profile.warning ? (
            <Text key={id} className="text-sm text-foreground-muted">
              {id}: {profile.warning}
            </Text>
          ) : null,
        )}
        {catalog?.error || query.error ? (
          <Text className="text-sm text-foreground-muted">{catalog?.error ?? query.error}</Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
