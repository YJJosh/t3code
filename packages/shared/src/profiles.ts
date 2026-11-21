import type {
  ModelSelection,
  ProfileCatalog,
  SelectProviderOptionDescriptor,
  ServerProvider,
} from "@t3tools/contracts";

export function supportsProfiles(driver: string): boolean {
  return ["claudeAgent", "codex", "muse", "pi", "acpRegistry", "antigravity"].includes(driver);
}

export function selectProfile(
  current: ModelSelection,
  id: string | null,
  profile: ProfileCatalog["profiles"][string] | undefined,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "models">>,
): { selection: ModelSelection; notice?: string } {
  if (id === null) return { selection: { ...current, profileId: null } };
  if (profile === undefined || profile.warning) return { selection: current };
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
  const target = provider ?? providers.find((entry) => entry.instanceId === instanceId);
  // ACP agents name their reasoning control themselves, such as Antigravity's `thinking_level`.
  const reasoning = target?.models
    .find((entry) => entry.slug === model)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor): descriptor is SelectProviderOptionDescriptor =>
        descriptor.type === "select" && descriptor.role === "reasoning",
    );
  const effort =
    reasoning === undefined || reasoning.options.some((choice) => choice.id === profile.effort)
      ? profile.effort
      : undefined;
  const effortId =
    reasoning?.id ??
    (target?.driver === "claudeAgent"
      ? "effort"
      : target?.driver === "pi"
        ? "thinking"
        : "reasoningEffort");
  const options = instanceId === current.instanceId ? (current.options ?? []) : [];
  return {
    selection: {
      ...current,
      profileId: id,
      instanceId,
      model,
      options,
      ...(effort
        ? {
            options: [
              ...options.filter((option) => option.id !== effortId),
              { id: effortId, value: effort },
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
