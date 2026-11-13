import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import type { EnvironmentId, ModelSelection, ServerConfig, ThreadId } from "@t3tools/contracts";
import { selectProfile, supportsProfiles } from "@t3tools/shared/profiles";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { selectThreadModel } from "../../state/thread-model-selection";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function ProfilePicker(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  selection: ModelSelection;
  config: ServerConfig | null;
  disabled: boolean;
  draftKey?: string;
}) {
  // Settings → Refresh updates this query, not the connection's config copy.
  const fresh = useEnvironmentQuery(
    serverEnvironment.profileConfig({ environmentId: props.environmentId, input: {} }),
  );
  const catalog = fresh.data?.profiles ?? props.config?.profiles;
  if (!catalog || (Object.keys(catalog.profiles).length === 0 && !props.selection.profileId))
    return null;
  const providers = props.config?.providers ?? [];
  const driver = providers.find(
    (provider) => provider.instanceId === props.selection.instanceId,
  )?.driver;
  const supported = driver !== undefined && supportsProfiles(driver);
  if (!supported)
    return (
      <Button
        onPress={() => {}}
        tone="text"
        label="Profiles"
        accessibilityHint="This provider doesn't use profiles"
        disabled
      />
    );
  return (
    <Menu
      accessibilityLabel="Profile"
      actions={[
        { id: "", title: "No profile", state: props.selection.profileId ? "off" : "on" },
        ...Object.entries(catalog.profiles).map(([id, profile]) => ({
          id,
          title: id,
          subtitle: profile.warning ?? profile.description,
          attributes: { disabled: Boolean(profile.warning) },
          state: props.selection.profileId === id ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (props.disabled) return;
        const id = nativeEvent.event || null;
        if (id && catalog.profiles[id]?.warning) return;
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
        if (props.draftKey)
          updateComposerDraftSettings(props.draftKey, { modelSelection: picked.selection });
        else selectThreadModel(props, picked.selection);
        Dialog.alert(
          "Profile selected",
          `${picked.notice ? `${picked.notice}\n\n` : ""}Applies at the next session start. Stop and restart the thread to apply immediately.`,
        );
      }}
    >
      <Button
        onPress={() => {}}
        tone="text"
        label={props.selection.profileId ?? "No profile"}
        disabled={props.disabled}
      />
    </Menu>
  );
}
