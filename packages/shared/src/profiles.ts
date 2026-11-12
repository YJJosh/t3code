import type { ModelSelection, Profile, ServerProvider } from "@t3tools/contracts";

export function supportsProfiles(driver: string): boolean {
  return ["claudeAgent", "codex", "muse", "pi", "acpRegistry"].includes(driver);
}

export function selectProfile(
  current: ModelSelection,
  id: string | null,
  profile: Profile | undefined,
  providers: ReadonlyArray<ServerProvider>,
): { selection: ModelSelection; notice?: string } {
  if (id === null || profile === undefined) return { selection: { ...current, profileId: id } };
  const named = profile.provider;
  const exact = providers.find((provider) => provider.instanceId === named);
  // Portable instance ids use the driver's id as a prefix, e.g. claudeAgent-lean.
  const fallback =
    named && !exact
      ? providers.find(
          (provider) =>
            String(provider.instanceId) === String(provider.driver) &&
            (named.startsWith(`${provider.driver}-`) || named.startsWith(`${provider.driver}_`)),
        )
      : undefined;
  const provider = exact ?? fallback;
  const instanceId = provider?.instanceId ?? current.instanceId;
  const model =
    profile.model ??
    (instanceId === current.instanceId
      ? current.model
      : (provider?.models[0]?.slug ?? current.model));
  const driver =
    provider?.driver ?? providers.find((entry) => entry.instanceId === instanceId)?.driver;
  const effortId =
    driver === "claudeAgent" ? "effort" : driver === "pi" ? "thinking" : "reasoningEffort";
  const options = instanceId === current.instanceId ? (current.options ?? []) : [];
  return {
    selection: {
      ...current,
      profileId: id,
      instanceId,
      model,
      options,
      ...(profile.effort
        ? {
            options: [
              ...options.filter((option) => option.id !== effortId),
              { id: effortId, value: profile.effort },
            ],
          }
        : {}),
    },
    ...(named && !exact
      ? {
          notice: `Provider ${named} is not installed here. Using ${instanceId}; check the model before sending.`,
        }
      : {}),
  };
}
