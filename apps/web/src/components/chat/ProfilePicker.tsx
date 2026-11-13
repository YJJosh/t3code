import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ModelSelection } from "@t3tools/contracts";
import { selectProfile, supportsProfiles } from "@t3tools/shared/profiles";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { serverEnvironment } from "../../state/server";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";

/** A menu entry, not a profile: profile names cannot start with "_". */
const EDIT_PROFILES = "__edit_profiles__";

export function ProfilePicker(props: {
  environmentId: EnvironmentId;
  target: ComposerThreadTarget;
  selection: ModelSelection;
  disabled?: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const apply = useApplyThreadModelPick();
  const navigate = useNavigate();
  const fresh = useAtomValue(
    serverEnvironment.profileConfig({ environmentId: props.environmentId, input: {} }),
  );
  const catalog = AsyncResult.getOrElse(fresh, () => null)?.profiles ?? config?.profiles;
  if (
    !config ||
    !catalog ||
    (Object.keys(catalog.profiles).length === 0 && !props.selection.profileId)
  )
    return null;
  const driver = config.providers.find(
    (provider) => provider.instanceId === props.selection.instanceId,
  )?.driver;
  const supported = driver !== undefined && supportsProfiles(driver);
  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>
        <Select
          value={props.selection.profileId ?? ""}
          disabled={props.disabled || !supported}
          onValueChange={(value) => {
            if (value === EDIT_PROFILES) {
              void navigate({ to: "/settings/profiles", search: { machine: props.environmentId } });
              return;
            }
            const id = value || null;
            if (id && catalog.profiles[id]?.warning) return;
            const picked = selectProfile(
              props.selection,
              id,
              id ? catalog.profiles[id] : undefined,
              config.providers,
            );
            const selectedDriver = config.providers.find(
              (provider) => provider.instanceId === picked.selection.instanceId,
            )?.driver;
            if (id && (!selectedDriver || !supportsProfiles(selectedDriver))) {
              toastManager.add({ type: "warning", title: "Profiles not supported here" });
              return;
            }
            useComposerDraftStore.getState().setModelSelection(props.target, picked.selection, {
              explicit: true,
              replaceOptions: true,
            });
            void apply(props.target);
            toastManager.add({
              type: "info",
              title: picked.notice ?? "Profile selected for the next session start",
            });
          }}
        >
          <SelectTrigger size="compact" variant="ghost" aria-label="Profile">
            <SelectValue>{props.selection.profileId ?? "No profile"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <p className="max-w-72 px-3 py-2 text-xs text-muted-foreground">
              Changes apply at the next session start. Stop and restart the thread to apply
              immediately.
            </p>
            <SelectItem value="">No profile</SelectItem>
            {Object.entries(catalog.profiles).map(([id, profile]) => (
              <SelectItem key={id} value={id} disabled={Boolean(profile.warning)}>
                {id}
                {profile.description ? `: ${profile.description}` : ""}
                {profile.warning ? `: ${profile.warning}` : ""}
              </SelectItem>
            ))}
            <SelectItem value={EDIT_PROFILES}>Edit profiles…</SelectItem>
          </SelectPopup>
        </Select>
      </TooltipTrigger>
      <TooltipPopup>
        {supported ? "Profile for the next session start" : "This provider doesn't use profiles"}
      </TooltipPopup>
    </Tooltip>
  );
}
