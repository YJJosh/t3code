import { ProviderInstanceId, type ModelSelection, type ClientSettings } from "@t3tools/contracts";

const dulli = ProviderInstanceId.make("dulli");

/** Only an explicit server cutover signal identifies the fork's Pi. Merely
 * having Dulli installed (or upstream Pi disabled) is not evidence. */
export interface DulliMigrationConfig {
  readonly legacyPiProviderMigrated?: boolean | undefined;
  readonly providers: ReadonlyArray<{ readonly instanceId: string; readonly driver: string }>;
}

export function isDulliCutover(config: DulliMigrationConfig): boolean {
  return (
    config.legacyPiProviderMigrated === true &&
    config.providers.some(
      (provider) => provider.instanceId === "dulli" && provider.driver === "dulli",
    )
  );
}

export function migrateForkPiSelection<T extends ModelSelection | null | undefined>(
  selection: T,
): T {
  return selection?.instanceId === "pi" ? { ...selection, instanceId: dulli } : selection;
}

/** Keep an already selected Dulli value on collision; never overwrite it. */
export function migrateForkPiMap<T>(
  map: Readonly<Record<ProviderInstanceId, T>>,
): Record<ProviderInstanceId, T>;
export function migrateForkPiMap<T>(
  map: Readonly<Partial<Record<ProviderInstanceId, T>>>,
): Partial<Record<ProviderInstanceId, T>>;
export function migrateForkPiMap<T>(
  map: Readonly<Partial<Record<ProviderInstanceId, T>>>,
): Partial<Record<ProviderInstanceId, T>> {
  const pi = ProviderInstanceId.make("pi");
  if (!(pi in map)) return map;
  const { [pi]: old, ...rest } = map;
  return { ...rest, ...(dulli in rest ? {} : { [dulli]: old }) };
}

/** Retired client preferences have no environment identity. Translate only at
 * handoff to a migrated server, keeping the original blob usable upstream. */
export function migrateForkPiPreferences(
  preferences: Pick<ClientSettings, "favorites" | "providerModelPreferences">,
): Pick<ClientSettings, "favorites" | "providerModelPreferences"> {
  return {
    favorites: preferences.favorites.map((favorite) =>
      favorite.provider === "pi" ? { ...favorite, provider: dulli } : favorite,
    ),
    providerModelPreferences: migrateForkPiMap(preferences.providerModelPreferences),
  };
}

export function migrateForkPiSelections(
  map: Readonly<Partial<Record<ProviderInstanceId, ModelSelection>>>,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(migrateForkPiMap(map)).map(([id, selection]) => [
      id,
      migrateForkPiSelection(selection),
    ]),
  );
}
