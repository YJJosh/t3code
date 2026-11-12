import type { EnvironmentId, ModelSelection, ServerConfig, ThreadId } from "@t3tools/contracts";
import { selectProfile, supportsProfiles } from "@t3tools/shared/profiles";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { selectThreadModel } from "../../state/thread-model-selection";

export function ProfilePicker(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  selection: ModelSelection;
  config: ServerConfig | null;
  disabled: boolean;
}) {
  const catalog = props.config?.profiles;
  if (!catalog || (Object.keys(catalog.profiles).length === 0 && !props.selection.profileId))
    return null;
  const providers = props.config?.providers ?? [];
  const driver = providers.find(
    (provider) => provider.instanceId === props.selection.instanceId,
  )?.driver;
  const supported = driver !== undefined && supportsProfiles(driver);
  return (
    <Menu
      accessibilityLabel="Profile"
      actions={[
        { id: "", title: "No profile", state: props.selection.profileId ? "off" : "on" },
        ...Object.entries(catalog.profiles).map(([id, profile]) => ({
          id,
          title: id,
          subtitle: profile.description,
          state: props.selection.profileId === id ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (props.disabled) return;
        const id = nativeEvent.event || null;
        const picked = selectProfile(
          props.selection,
          id,
          id ? catalog.profiles[id] : undefined,
          providers,
        );
        const nextDriver = providers.find(
          (provider) => provider.instanceId === picked.selection.instanceId,
        )?.driver;
        if (id && (!nextDriver || !supportsProfiles(nextDriver))) {
          Dialog.alert("Profiles not supported here");
          return;
        }
        selectThreadModel(props, picked.selection);
        Dialog.alert(
          "Profile saved",
          `${picked.notice ? `${picked.notice}\n\n` : ""}Applies at the next session start. Stop and restart the thread to apply immediately.`,
        );
      }}
    >
      <Button
        onPress={() => {}}
        tone="text"
        label={
          supported ? (props.selection.profileId ?? "No profile") : "Profiles not supported here"
        }
        disabled={props.disabled}
      />
    </Menu>
  );
}
