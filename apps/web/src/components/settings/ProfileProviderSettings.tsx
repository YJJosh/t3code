import type {
  ClaudeProviderSettings,
  CodexProviderSettings,
  PiProviderSettings,
  ProfileProviderSettingsDriver,
  ProviderSettingsFile,
  ProviderSettingsOptions,
} from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  booleanOfTriState,
  formatJsonObject,
  type JsonObject,
  parseJsonObject,
  PROFILE_DRIVER_LABELS,
  PROFILE_DRIVERS,
  profileNameError,
  type SettingsOption,
  settingsOptions,
  toggleInOptionalList,
  type TriState,
  triStateOf,
  uniqueName,
  withFeature,
  withKey,
} from "./ProfilesSettings.logic";

type Entry = ClaudeProviderSettings | CodexProviderSettings | PiProviderSettings;

const TRI_STATE_LABELS: Record<TriState, string> = {
  default: "Default",
  on: "On",
  off: "Off",
};

export interface ProviderSettingsEditorProps {
  readonly value: ProviderSettingsFile;
  readonly options: ProviderSettingsOptions | null;
  readonly optionsError: string | null;
  readonly optionsPending: boolean;
  readonly onRefreshOptions: () => void;
  readonly disabled: boolean;
  /** Unsaved edits here; renames and deletes rewrite profiles and so need a clean section. */
  readonly dirty: boolean;
  readonly onChange: (next: ProviderSettingsFile) => void;
  readonly onRename: (
    driver: ProfileProviderSettingsDriver,
    from: string,
    to: string | null,
  ) => void;
  readonly usedBy: (driver: ProfileProviderSettingsDriver, name: string) => string[];
  /** Bumped when the draft is discarded or saved, so text fields reread the saved value. */
  readonly resetKey: number;
  readonly onJsonValidity: (key: string, valid: boolean) => void;
}

export function ProviderSettingsEditor(props: ProviderSettingsEditorProps) {
  const [driver, setDriver] = useState<ProfileProviderSettingsDriver>("claudeAgent");
  const entries = props.value[driver] ?? {};
  const names = Object.keys(entries);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && selected in entries ? selected : (names[0] ?? null);
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const newNameError = newName === "" ? null : profileNameError(newName, names);
  const renameError =
    renameTo === "" || renameTo === current ? null : profileNameError(renameTo, names);

  const setEntries = (next: Readonly<Record<string, Entry>>) =>
    props.onChange(withKey(props.value, driver, Object.keys(next).length === 0 ? undefined : next));
  const setEntry = (name: string, entry: Entry) => setEntries({ ...entries, [name]: entry });

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label="Provider"
          value={[driver]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "claudeAgent" || value === "codex" || value === "pi") {
              setDriver(value);
              setSelected(null);
              setRenameTo("");
            }
          }}
        >
          {PROFILE_DRIVERS.map((id) => (
            <Toggle key={id} value={id}>
              {PROFILE_DRIVER_LABELS[id]}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          size="xs"
          variant="outline"
          disabled={props.optionsPending}
          onClick={props.onRefreshOptions}
        >
          {props.optionsPending ? "Detecting…" : "Detect options again"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Options come from what this machine’s {PROFILE_DRIVER_LABELS[driver]} reports. Muse and
        other providers have no provider settings.
      </p>
      {props.optionsError ? (
        <p role="alert" className="text-xs text-destructive">
          {props.optionsError}
        </p>
      ) : null}
      {props.options?.[driver]?.error ? (
        <p role="status" className="text-xs text-warning">
          {props.options[driver]?.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {names.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No named {PROFILE_DRIVER_LABELS[driver]} settings. Profiles use the provider default.
          </p>
        ) : (
          <Select
            value={current ?? ""}
            onValueChange={(value) => {
              setSelected(value);
              setRenameTo("");
            }}
          >
            <SelectTrigger size="sm" aria-label={`${PROFILE_DRIVER_LABELS[driver]} settings`}>
              <SelectValue>{current}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {names.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Input
          aria-label="New settings name"
          placeholder="New settings name"
          value={newName}
          disabled={props.disabled}
          aria-invalid={newNameError !== null}
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || newName === "" || newNameError !== null}
          onClick={() => {
            setEntry(newName, {});
            setSelected(newName);
            setNewName("");
          }}
        >
          Add
        </Button>
        {current !== null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={() => {
              const copy = uniqueName(`${current}-copy`, names);
              setEntry(copy, entries[current] ?? {});
              setSelected(copy);
            }}
          >
            Duplicate
          </Button>
        ) : null}
      </div>
      {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}

      {current !== null ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Rename settings"
              placeholder={current}
              value={renameTo}
              disabled={props.disabled || props.dirty}
              aria-invalid={renameError !== null}
              onChange={(event) => setRenameTo(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={
                props.disabled ||
                props.dirty ||
                renameTo === "" ||
                renameTo === current ||
                renameError !== null
              }
              onClick={() => {
                props.onRename(driver, current, renameTo);
                setSelected(renameTo);
                setRenameTo("");
              }}
            >
              Rename
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={props.disabled || props.dirty}
              onClick={() => props.onRename(driver, current, null)}
            >
              Delete
            </Button>
          </div>
          {renameError ? <p className="text-xs text-destructive">{renameError}</p> : null}
          {props.dirty ? (
            <p className="text-xs text-muted-foreground">
              Save or discard edits before renaming or deleting; profiles that use these settings
              change with them.
            </p>
          ) : null}
          {props.usedBy(driver, current).length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Used by {props.usedBy(driver, current).join(", ")}.
            </p>
          ) : null}
          <DescriptionField
            value={entries[current]?.description}
            disabled={props.disabled}
            onChange={(description) =>
              setEntry(current, withKey(entries[current] ?? {}, "description", description))
            }
          />
          {driver === "claudeAgent" ? (
            <ClaudeForm
              key={`${current}:${props.resetKey}`}
              entry={props.value.claudeAgent?.[current] ?? {}}
              options={props.options?.claudeAgent}
              disabled={props.disabled}
              onChange={(entry) => setEntry(current, entry)}
              onJsonValidity={(valid) => props.onJsonValidity(`claudeAgent:${current}`, valid)}
            />
          ) : driver === "codex" ? (
            <CodexForm
              key={`${current}:${props.resetKey}`}
              entry={props.value.codex?.[current] ?? {}}
              options={props.options?.codex}
              disabled={props.disabled}
              onChange={(entry) => setEntry(current, entry)}
              onJsonValidity={(valid) => props.onJsonValidity(`codex:${current}`, valid)}
            />
          ) : (
            <PiForm
              entry={props.value.pi?.[current] ?? {}}
              disabled={props.disabled}
              onChange={(entry) => setEntry(current, entry)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function DescriptionField(props: {
  value: string | undefined;
  disabled: boolean;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Input
      aria-label="Description"
      placeholder="Description"
      value={props.value ?? ""}
      disabled={props.disabled}
      onChange={(event) =>
        props.onChange(event.target.value.trim() === "" ? undefined : event.target.value)
      }
    />
  );
}

function FieldRow(props: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{props.title}</p>
        {props.description ? (
          <p className="text-xs text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{props.children}</div>
    </div>
  );
}

/** A switch for an optional boolean: `fallback` is what leaving it out means. */
function OptionalSwitch(props: {
  title: string;
  description?: string;
  value: boolean | undefined;
  fallback: boolean;
  disabled: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <FieldRow
      title={props.title}
      {...(props.description ? { description: props.description } : {})}
    >
      <Switch
        aria-label={props.title}
        checked={props.value ?? props.fallback}
        disabled={props.disabled}
        onCheckedChange={(checked) =>
          props.onChange(Boolean(checked) === props.fallback ? undefined : Boolean(checked))
        }
      />
    </FieldRow>
  );
}

function TriStateSelect(props: {
  label: string;
  value: TriState;
  disabled: boolean;
  onChange: (value: TriState) => void;
}) {
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value === "default" || value === "on" || value === "off") props.onChange(value);
      }}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue>{TRI_STATE_LABELS[props.value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {(["default", "on", "off"] as const).map((state) => (
          <SelectItem key={state} value={state}>
            {TRI_STATE_LABELS[state]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Checked names are the ones listed, such as blocked tools or turned-off skills. */
function NameChecklist(props: {
  title: string;
  description: string;
  options: ReadonlyArray<SettingsOption>;
  checked: ReadonlyArray<string> | undefined;
  disabled: boolean;
  onChange: (next: ReadonlyArray<string> | undefined) => void;
}) {
  const checked = new Set(props.checked ?? []);
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-sm text-foreground">{props.title}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.options.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing reported on this machine.</p>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {props.options.map((option) => (
            <label key={option.name} className="flex min-w-0 items-center gap-2 text-xs">
              <Checkbox
                checked={checked.has(option.name)}
                disabled={props.disabled}
                onCheckedChange={(on) =>
                  props.onChange(toggleInOptionalList(props.checked, option.name, on === true))
                }
              />
              <span className="truncate">{option.name}</span>
              {option.detected ? null : (
                <Badge variant="outline" size="sm">
                  not on this machine
                </Badge>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function JsonField(props: {
  title: string;
  description: string;
  value: JsonObject | undefined;
  disabled: boolean;
  onChange: (value: JsonObject | undefined) => void;
  onValidity: (valid: boolean) => void;
}) {
  const [text, setText] = useState(() => formatJsonObject(props.value));
  const parsed = parseJsonObject(text);
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-sm text-foreground">{props.title}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Textarea
        aria-label={props.title}
        value={text}
        disabled={props.disabled}
        aria-invalid={!parsed.ok}
        onChange={(event) => {
          const next = parseJsonObject(event.target.value);
          setText(event.target.value);
          props.onValidity(next.ok);
          if (next.ok) props.onChange(next.value);
        }}
      />
      {parsed.ok ? null : <p className="text-xs text-destructive">{parsed.error}</p>}
    </div>
  );
}

function ClaudeForm(props: {
  entry: ClaudeProviderSettings;
  options: ProviderSettingsOptions["claudeAgent"];
  disabled: boolean;
  onChange: (entry: ClaudeProviderSettings) => void;
  onJsonValidity: (valid: boolean) => void;
}) {
  const { entry, disabled } = props;
  const set = <K extends keyof ClaudeProviderSettings>(
    key: K,
    value: ClaudeProviderSettings[K] | undefined,
  ) => props.onChange(withKey(entry, key, value));
  return (
    <div className="space-y-3">
      <NameChecklist
        title="Blocked tools"
        description="Claude may not use these. T3’s own tools are never blocked."
        options={settingsOptions(props.options?.tools, entry.blockedTools ?? [])}
        checked={entry.blockedTools}
        disabled={disabled}
        onChange={(next) => set("blockedTools", next)}
      />
      <OptionalSwitch
        title="Bundled skills"
        description="Skills that ship with Claude Code."
        value={entry.bundledSkills}
        fallback
        disabled={disabled}
        onChange={(value) => set("bundledSkills", value)}
      />
      <NameChecklist
        title="Turned-off skills"
        description="Installed Claude skills left out of the session."
        options={settingsOptions(props.options?.skills, entry.disabledSkills ?? [])}
        checked={entry.disabledSkills}
        disabled={disabled}
        onChange={(next) => set("disabledSkills", next)}
      />
      <NameChecklist
        title="Turned-off plugins"
        description="Installed Claude plugins left out of the session."
        options={settingsOptions(props.options?.plugins, entry.disabledPlugins ?? [])}
        checked={entry.disabledPlugins}
        disabled={disabled}
        onChange={(next) => set("disabledPlugins", next)}
      />
      <FieldRow title="Auto memory" description="Default follows your Claude settings.">
        <TriStateSelect
          label="Auto memory"
          value={triStateOf(entry.autoMemory)}
          disabled={disabled}
          onChange={(state) => set("autoMemory", booleanOfTriState(state))}
        />
      </FieldRow>
      <OptionalSwitch
        title="Co-author"
        description="Claude’s attribution on commits and pull requests."
        value={entry.coAuthor}
        fallback
        disabled={disabled}
        onChange={(value) => set("coAuthor", value)}
      />
      <OptionalSwitch
        title="Claude in Chrome"
        value={entry.chrome}
        fallback={false}
        disabled={disabled}
        onChange={(value) => set("chrome", value)}
      />
      <JsonField
        title="Advanced settings"
        description="Further Claude Code settings keys, as JSON. Keys T3 needs are ignored."
        value={entry.settings}
        disabled={disabled}
        onChange={(value) => set("settings", value)}
        onValidity={props.onJsonValidity}
      />
    </div>
  );
}

function CodexForm(props: {
  entry: CodexProviderSettings;
  options: ProviderSettingsOptions["codex"];
  disabled: boolean;
  onChange: (entry: CodexProviderSettings) => void;
  onJsonValidity: (valid: boolean) => void;
}) {
  const { entry, disabled } = props;
  const features = settingsOptions(props.options?.features, Object.keys(entry.features ?? {}));
  const unapplied = [...(entry.disabledSkills ?? []), ...(entry.disabledPlugins ?? [])];
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-sm text-foreground">Features</p>
        {features.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing reported on this machine.</p>
        ) : (
          <div className="space-y-1">
            {features.map((feature) => (
              <div key={feature.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-xs">
                  {feature.name}
                  {feature.enabled === undefined
                    ? ""
                    : feature.enabled
                      ? " (on by default)"
                      : " (off by default)"}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {feature.detected ? null : (
                    <Badge variant="outline" size="sm">
                      not on this machine
                    </Badge>
                  )}
                  <TriStateSelect
                    label={feature.name}
                    value={triStateOf(entry.features?.[feature.name])}
                    disabled={disabled}
                    onChange={(state) =>
                      props.onChange(
                        withKey(
                          entry,
                          "features",
                          withFeature(entry.features, feature.name, state),
                        ),
                      )
                    }
                  />
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {unapplied.length > 0 ? (
        <FieldRow
          title="Turned-off skills and plugins"
          description={`${unapplied.join(", ")}. Codex cannot turn these off for one thread yet, so T3 does not apply them.`}
        >
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              props.onChange(
                withKey(withKey(entry, "disabledSkills", undefined), "disabledPlugins", undefined),
              )
            }
          >
            Clear
          </Button>
        </FieldRow>
      ) : null}
      <JsonField
        title="Advanced config"
        description="Further dotted config keys, as JSON. Keys T3 needs are refused."
        value={entry.config}
        disabled={disabled}
        onChange={(value) => props.onChange(withKey(entry, "config", value))}
        onValidity={props.onJsonValidity}
      />
    </div>
  );
}

function PiForm(props: {
  entry: PiProviderSettings;
  disabled: boolean;
  onChange: (entry: PiProviderSettings) => void;
}) {
  return (
    <div className="space-y-3">
      <OptionalSwitch
        title="Pi skills"
        description="Off starts Pi without its own skills. Profile skills are still listed."
        value={props.entry.skills}
        fallback
        disabled={props.disabled}
        onChange={(value) => props.onChange(withKey(props.entry, "skills", value))}
      />
      <OptionalSwitch
        title="Prompt templates"
        value={props.entry.promptTemplates}
        fallback
        disabled={props.disabled}
        onChange={(value) => props.onChange(withKey(props.entry, "promptTemplates", value))}
      />
    </div>
  );
}
