import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export function ProfilesSettings() {
  const { environment, scope } = useSettingsScope();
  if (!environment || scope.kind === "project" || scope.kind === "checkout") return null;
  return (
    <EnvironmentProfilesSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

function EnvironmentProfilesSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId, (settings) => settings);
  const update = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = serverEnvironment.profileConfig({ environmentId, input: {} });
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const catalog = AsyncResult.getOrElse(result, () => null)?.profiles;
  return (
    <SettingsSection
      id="profiles"
      title="Profiles"
      headerAction={
        <Button size="xs" variant="outline" onClick={refresh}>
          Refresh profiles
        </Button>
      }
    >
      <SettingsRow
        title="Profiles folder"
        description={
          catalog?.folder ??
          "Leave blank to use <T3 home>/profiles. Missing or empty folders disable profiles."
        }
        control={
          <Input
            aria-label="Profiles folder"
            defaultValue={settings.profilesFolder}
            disabled={!canWrite}
            onBlur={(event) => {
              if (event.target.value !== settings.profilesFolder)
                update({ profilesFolder: event.target.value });
            }}
          />
        }
      />
      <SettingsRow
        title="Default profile for new threads"
        description="Does not affect existing threads or delegated children."
        control={
          <Select
            value={settings.defaultProfile ?? "__folder__"}
            disabled={!canWrite}
            onValueChange={(value) => {
              void update({ defaultProfile: value === "__folder__" ? null : value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Default profile for new threads">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="__folder__">Folder default</SelectItem>
              <SelectItem value="">No profile</SelectItem>
              {Object.keys(catalog?.profiles ?? {}).map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {catalog?.error ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {catalog.error}
        </p>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {Object.keys(catalog?.profiles ?? {}).length} profiles available. Refresh after syncing.
          Profile changes apply at the next session start.
        </p>
      )}
    </SettingsSection>
  );
}
