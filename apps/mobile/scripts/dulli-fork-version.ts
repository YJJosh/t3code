export function resolveDulliForkVersion(raw: string | undefined) {
  const value = raw?.trim();
  const match = value === undefined ? null : /^0\.0\.(0|[1-9]\d*)-pi\.(0|[1-9]\d*)$/.exec(value);
  if (value === undefined || value === "" || match === null) {
    throw new Error(
      "T3CODE_MOBILE_FORK_VERSION must use the 0.0.<patch>-pi.<build> release sequence, such as 0.0.31-pi.4.",
    );
  }
  const [, patch, prerelease] = match;
  const patchNumber = Number(patch);
  const prereleaseNumber = Number(prerelease);
  // A fixed pi.N sequence makes this monotonic: increasing patch numbers always
  // outrank the 10,000 prerelease slots reserved for the previous patch.
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
