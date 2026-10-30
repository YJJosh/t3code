import {
  isBackgroundTerminalActive,
  type BackgroundTerminalEntry,
  type BackgroundTerminalOutputBuffer,
} from "@t3tools/client-runtime/state/background-terminals";
import type {
  DulliBackgroundTerminalStatus,
  DulliBackgroundTerminalView,
} from "@t3tools/contracts";

import { formatElapsedDurationLabel } from "../../timestampFormat";

export type BackgroundTerminalStatusTone = "info" | "warning" | "success" | "error";

const STATUS_LABELS: Record<DulliBackgroundTerminalStatus, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  killed: "Killed",
};

const STATUS_TONES: Record<DulliBackgroundTerminalStatus, BackgroundTerminalStatusTone> = {
  running: "info",
  done: "success",
  failed: "error",
  killed: "warning",
};

export function backgroundTerminalStatusLabel(status: DulliBackgroundTerminalStatus): string {
  return STATUS_LABELS[status];
}

export function backgroundTerminalStatusTone(
  status: DulliBackgroundTerminalStatus,
): BackgroundTerminalStatusTone {
  return STATUS_TONES[status];
}

/** Short, human title for a terminal row: prefer the title, then the command, then the id. */
export function backgroundTerminalTitle(view: DulliBackgroundTerminalView): string {
  const title = view.title.trim();
  if (title.length > 0) {
    return title;
  }
  const command = view.command.trim();
  return command.length > 0 ? command : view.id;
}

/** Accessible status string, calling out failures explicitly. */
export function backgroundTerminalAccessibleStatus(status: DulliBackgroundTerminalStatus): string {
  const label = backgroundTerminalStatusLabel(status);
  return status === "failed" ? `${label}: needs your attention` : label;
}

export type BackgroundTerminalRosterGroup = "running" | "settled";

export type BackgroundTerminalRosterGroups = Record<
  BackgroundTerminalRosterGroup,
  ReadonlyArray<BackgroundTerminalEntry>
>;

/**
 * Split terminals into running and settled (done, failed, killed) groups,
 * each shown behind its own summary row. Creation order is preserved
 * within each group.
 */
export function groupBackgroundTerminalsForRoster(
  entries: ReadonlyArray<BackgroundTerminalEntry>,
): BackgroundTerminalRosterGroups {
  const running: BackgroundTerminalEntry[] = [];
  const settled: BackgroundTerminalEntry[] = [];
  for (const entry of entries) {
    (isBackgroundTerminalActive(entry.view.status) ? running : settled).push(entry);
  }
  return { running, settled };
}

/** Label for a roster group's summary row, e.g. "2 running terminals". */
export function backgroundTerminalRosterSummaryLabel(
  group: BackgroundTerminalRosterGroup,
  count: number,
): string {
  return `${count} ${group} terminal${count === 1 ? "" : "s"}`;
}

/** Elapsed duration from creation to settlement (or now, while still running). */
export function backgroundTerminalElapsedLabel(
  view: DulliBackgroundTerminalView,
  nowMs: number = Date.now(),
): string {
  const endMs = view.settledAt ?? nowMs;
  if (!Number.isFinite(view.createdAt) || !Number.isFinite(endMs)) return "";
  return formatElapsedDurationLabel(new Date(view.createdAt).toISOString(), endMs);
}

/** Human-readable outcome for a settled terminal, e.g. "Exit code 1" or "Signal SIGTERM". */
export function backgroundTerminalExitSummary(view: DulliBackgroundTerminalView): string | null {
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
const CSI_CHAR = String.fromCharCode(0x9b);
const OSC_CHAR = String.fromCharCode(0x9d);
const STRING_TERMINATOR_CHAR = String.fromCharCode(0x9c);

// Standards-shaped ANSI matchers. CSI accepts private parameters and
// intermediate bytes (for example ESC [ ? 25 l), while OSC accepts BEL or
// string-terminator endings. Remaining two-byte/charset escape forms are
// removed separately so a stripped ESC never leaves visible garbage behind.
const ANSI_OSC_PATTERN = `(?:${ESCAPE_CHAR}\\]|${OSC_CHAR})(?:[^${BELL_CHAR}${ESCAPE_CHAR}${STRING_TERMINATOR_CHAR}]|${ESCAPE_CHAR}(?!\\\\))*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\|${STRING_TERMINATOR_CHAR})`;
const ANSI_CSI_PATTERN = `(?:${ESCAPE_CHAR}\\[|${CSI_CHAR})[0-?]*[ -/]*[@-~]`;
const ANSI_OTHER_ESCAPE_PATTERN = `${ESCAPE_CHAR}(?:[()][0-2A-Z]|[ -/]*[@-~])`;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${ANSI_OSC_PATTERN}|${ANSI_CSI_PATTERN}|${ANSI_OTHER_ESCAPE_PATTERN}`,
  "g",
);

// C0 control characters other than tab/newline/carriage-return, plus DEL.
const KEEP_CONTROL_CODES: ReadonlySet<number> = new Set([9, 10, 13]);

function stripOtherControlCharacters(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isUnwantedControl =
      (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) && !KEEP_CONTROL_CODES.has(code);
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
