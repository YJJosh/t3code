/**
 * Renderers answer the shell's queries (cursor position, device attributes, colors) and report
 * focus and mouse through the same write path as typing. Those reports are not the user taking a
 * turn, so only input left over after removing them counts.
 */
const TERMINAL_REPLY =
  /\x1b\[[?>=]?[\d;]*[Rcnt]|\x1b\[\??[\d;]*\$y|\x1b\[[IO]|\x1b\[<[\d;]*[Mm]|\x1b\[M[\s\S]{3}|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^][\s\S]*?\x1b\\/g;

export function isTerminalReplyOnly(data: string): boolean {
  return data.replace(TERMINAL_REPLY, "").length === 0;
}
