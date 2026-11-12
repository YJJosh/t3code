export function resolveDulliForkVersion(raw: string | undefined) {
  const value = raw?.trim();
  // Keep legacy pi releases readable without changing their Android versionCodes.
  const match =
    value === undefined
      ? null
      : /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:dulli|pi)\.(0|[1-9]\d*)$/.exec(value);
  if (value === undefined || value === "" || match === null) {
    throw new Error(
      "T3CODE_MOBILE_FORK_VERSION must use the 0.<minor>.<patch>-dulli.<build> release sequence, such as 0.1.0-dulli.1 (legacy -pi versions are also supported).",
    );
  }
  const [, minor, patch, prerelease] = match;
  const minorNumber = Number(minor);
  const patchNumber = Number(patch);
  const prereleaseNumber = Number(prerelease);
  // Suffixes share build slots. Reserve 1,000 patches per minor and 10,000
  // builds per patch, preserving the versionCodes of every 0.0.x release.
  const slot = minorNumber * 1_000 + patchNumber;
  const versionCode = slot * 10_000 + prereleaseNumber;
  if (
    patchNumber > 999 ||
    prereleaseNumber > 9_999 ||
    !Number.isSafeInteger(versionCode) ||
    versionCode > 2_100_000_000
  ) {
    throw new Error(
      `Cannot derive an Android versionCode from '${value}'; extend the scheme in dulli-fork-version.ts.`,
    );
  }
  return { versionName: value, versionCode };
}
