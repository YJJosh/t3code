import type { ProviderDriverKind } from "@t3tools/contracts";

export interface ProviderRuntimeModePresentation {
  readonly driver: ProviderDriverKind;
  readonly showRuntimeModeToggle?: boolean | undefined;
}

/**
 * Whether clients should present runtime/access mode controls for a provider.
 *
 * The driver fallback keeps Pi controls hidden when a newer client receives a
 * snapshot from an older server that predates `showRuntimeModeToggle`.
 */
export function getProviderRuntimeModeToggle(
  provider: ProviderRuntimeModePresentation | null | undefined,
): boolean {
  return provider?.showRuntimeModeToggle ?? provider?.driver !== "pi";
}
