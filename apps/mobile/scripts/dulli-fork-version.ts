export function resolveDulliForkVersion(raw: string | undefined) {
  const value = raw?.trim();
  // Keep legacy pi releases readable without changing their Android versionCodes.
  const match =
    value === undefined ? null : /^0\.0\.(0|[1-9]\d*)-(?:dulli|pi)\.(0|[1-9]\d*)$/.exec(value);
  if (value === undefined || value === "" || match === null) {
    throw new Error(
      "T3CODE_MOBILE_FORK_VERSION must use the 0.0.<patch>-dulli.<build> release sequence, such as 0.0.40-dulli.2 (legacy -pi versions are also supported).",
    );
  }
  const [, patch, prerelease] = match;
  const patchNumber = Number(patch);
  const prereleaseNumber = Number(prerelease);
  // Suffixes share build slots: pi.1 -> dulli.2 must keep increasing the build.
  // Each patch still reserves 10,000 slots, preserving legacy versionCodes.
  if (patchNumber > 209_999 || prereleaseNumber > 9_999) {
    throw new Error(
      `Cannot derive an Android versionCode from '${value}'; extend the scheme in dulli-fork-version.ts.`,
    );
  }
  return {
    versionName: value,
    versionCode: patchNumber * 10_000 + prereleaseNumber,
  };
}
