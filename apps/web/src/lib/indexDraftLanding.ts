export function canAutoStartIndexDraft(input: {
  readonly shellsBootstrapped: boolean;
  readonly primaryServerConfigReady: boolean;
}): boolean {
  return input.shellsBootstrapped && input.primaryServerConfigReady;
}
