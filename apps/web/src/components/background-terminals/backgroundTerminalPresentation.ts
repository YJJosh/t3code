import type {
  BackgroundTerminalEntry,
  BackgroundTerminalOutputBuffer,
} from "@t3tools/client-runtime/state/background-terminals";
import type { PiBackgroundTerminalStatus, PiBackgroundTerminalView } from "@t3tools/contracts";

import { formatElapsedDurationLabel } from "../../timestampFormat";

export type BackgroundTerminalStatusTone = "info" | "warning" | "success" | "error";

const STATUS_LABELS: Record<PiBackgroundTerminalStatus, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  killed: "Killed",
};

const STATUS_TONES: Record<PiBackgroundTerminalStatus, BackgroundTerminalStatusTone> = {
  running: "info",
  done: "success",
  failed: "error",
  killed: "warning",
};

/**
 * Statuses that no longer need attention: the terminal settled cleanly or was
 * stopped deliberately. Kept separate from `failed`, which stays in the
 * always-visible roster since a failure is something the user should notice.
 */
const QUIET_STATUSES: ReadonlySet<PiBackgroundTerminalStatus> = new Set(["done", "killed"]);

export function backgroundTerminalStatusLabel(status: PiBackgroundTerminalStatus): string {
  return STATUS_LABELS[status];
}

export function backgroundTerminalStatusTone(
  status: PiBackgroundTerminalStatus,
): BackgroundTerminalStatusTone {
  return STATUS_TONES[status];
}

/** True once a terminal is done/killed and can collapse out of the way. */
export function isBackgroundTerminalQuiet(status: PiBackgroundTerminalStatus): boolean {
  return QUIET_STATUSES.has(status);
}

/** Short, human title for a terminal row: prefer the title, then the command, then the id. */
export function backgroundTerminalTitle(view: PiBackgroundTerminalView): string {
  const title = view.title.trim();
  if (title.length > 0) {
    return title;
  }
  const command = view.command.trim();
  return command.length > 0 ? command : view.id;
}

/** Accessible status string, calling out failures explicitly. */
export function backgroundTerminalAccessibleStatus(status: PiBackgroundTerminalStatus): string {
  const label = backgroundTerminalStatusLabel(status);
  return status === "failed" ? `${label} — needs your attention` : label;
}

export interface BackgroundTerminalRosterGroups {
  /** Terminals that still need visibility: running or failed. */
  readonly attention: ReadonlyArray<BackgroundTerminalEntry>;
  /** Settled terminals (done/killed) that can collapse behind a summary. */
  readonly quiet: ReadonlyArray<BackgroundTerminalEntry>;
}

/**
 * Split terminals for the roster panel so running/failed terminals stay
 * always visible while settled terminals collapse behind a summary row.
 * Creation order is preserved within each group.
 */
export function groupBackgroundTerminalsForRoster(
  entries: ReadonlyArray<BackgroundTerminalEntry>,
): BackgroundTerminalRosterGroups {
  const attention: BackgroundTerminalEntry[] = [];
  const quiet: BackgroundTerminalEntry[] = [];
  for (const entry of entries) {
    (isBackgroundTerminalQuiet(entry.view.status) ? quiet : attention).push(entry);
  }
  return { attention, quiet };
}

/** Label for the collapsed settled-terminal summary row. */
export function backgroundTerminalRosterSummaryLabel(count: number): string {
  return `${count} settled terminal${count === 1 ? "" : "s"}`;
}

/** Elapsed duration from creation to settlement (or now, while still running). */
export function backgroundTerminalElapsedLabel(
  view: PiBackgroundTerminalView,
  nowMs: number = Date.now(),
): string {
  const endMs = view.settledAt ?? nowMs;
  return formatElapsedDurationLabel(view.createdAt, endMs);
}

/** Human-readable outcome for a settled terminal, e.g. "Exit code 1" or "Signal SIGTERM". */
export function backgroundTerminalExitSummary(view: PiBackgroundTerminalView): string | null {
  if (view.errorText !== undefined && view.errorText.trim().length > 0) {
    return view.errorText;
  }
  if (view.signal !== undefined) {
    return `Signal ${view.signal}`;
  }
  if (view.exitCode !== undefined) {
    return `Exit code ${view.exitCode}`;
  }
  return null;
}

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

/** Bytes absent from the client-retained tail across bridge and browser retention. */
export function backgroundTerminalTruncatedBytes(buffer: BackgroundTerminalOutputBuffer): number {
  return buffer.truncatedBytes + buffer.clientTruncatedBytes;
}

// Built from character codes (rather than literal escape characters in the
// regex source) so this file never embeds a raw ESC/BEL byte. CSI requires
// ESC directly followed by "[" and OSC requires ESC directly followed by
// "]", so the two can never ambiguously overlap.
const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);

// Strips ANSI CSI sequences (ESC [ ... letter, e.g. color/cursor codes) and
// OSC sequences (ESC ] ... BEL or ESC ] ... ESC \\, e.g. terminal title
// changes) so raw escape codes from a spawned process don't render as
// garbled text in the plain preformatted tail.
const ANSI_CSI_PATTERN = `${ESCAPE_CHAR}\\[[0-9;:]*[a-zA-Z]`;
const ANSI_OSC_PATTERN = `${ESCAPE_CHAR}\\][^${BELL_CHAR}${ESCAPE_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`;
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_CSI_PATTERN}|${ANSI_OSC_PATTERN}`, "g");

// C0 control characters other than tab/newline/carriage-return, plus DEL.
const KEEP_CONTROL_CODES: ReadonlySet<number> = new Set([9, 10, 13]);

function stripOtherControlCharacters(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isUnwantedControl = (code <= 0x1f || code === 0x7f) && !KEEP_CONTROL_CODES.has(code);
    if (!isUnwantedControl) {
      result += char;
    }
  }
  return result;
}

/** Strip ANSI escape sequences and non-printable control characters for safe plain-text display. */
export function sanitizeTerminalOutputText(text: string): string {
  return stripOtherControlCharacters(text.replaceAll(ANSI_ESCAPE_PATTERN, ""));
}
