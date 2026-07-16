import type {
  PiBackgroundTerminalControlInput,
  PiBackgroundTerminalEvent,
  PiBackgroundTerminalOutputDelta,
  PiBackgroundTerminalOutputView,
  PiBackgroundTerminalStatus,
  PiBackgroundTerminalView,
} from "@t3tools/contracts";

/**
 * Pure client-side state model for Pi background-terminal ("native, non-PTY
 * background command") events. Mirrors the shape of `subagentRuntime.ts` for
 * the analogous subagent stream, but background terminals have no discrete
 * per-event activity log to replay: each `PiBackgroundTerminalView` already
 * carries the *full* current stdout/stderr text for that terminal, so a
 * `terminal_upsert` (or a `snapshot`) can always rebuild a terminal's output
 * from scratch. `terminal_output` events instead carry small incremental
 * deltas so the common case (a running process printing output) doesn't
 * require re-sending the whole buffer on every line.
 *
 * Design constraints handled here:
 * - Ordered manager sequences: every event carries `managerId` + monotonic
 *   `sequence`; duplicates (re-delivered after reconnect) are ignored.
 * - Authoritative snapshots: a `snapshot` event rebuilds the whole terminal
 *   set from its `terminals` list, discarding anything not present (e.g. a
 *   fresh manager after reconnect starts from an empty set).
 * - Browser-side UTF-8 byte-bounded retention per stream (independent of any
 *   server-side truncation) so a long-lived, chatty terminal cannot grow the
 *   client's memory without bound.
 */

export const DEFAULT_MAX_BACKGROUND_TERMINAL_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_MAX_BACKGROUND_TERMINAL_CONTROL_RESULTS = 50;

export interface BackgroundTerminalOutputBuffer {
  /** Client-retained text for this stream, bounded to the configured byte budget. */
  readonly text: string;
  /** Total bytes ever written to this stream, as reported by the server. */
  readonly totalBytes: number;
  /** Bytes already dropped server-side (server-side retention limit). */
  readonly truncatedBytes: number;
  /** Additional bytes dropped by this client's own byte-bounded retention. */
  readonly clientTruncatedBytes: number;
}

export interface BackgroundTerminalEntry {
  readonly view: PiBackgroundTerminalView;
  readonly stdout: BackgroundTerminalOutputBuffer;
  readonly stderr: BackgroundTerminalOutputBuffer;
  readonly lastSequence: number;
  readonly updatedAt: string;
}

export interface BackgroundTerminalControlEntry {
  readonly requestId?: string | undefined;
  readonly action: PiBackgroundTerminalControlInput["action"];
  readonly success: boolean;
  readonly error?: string | undefined;
  readonly sequence: number;
  readonly timestamp: string;
}

export interface BackgroundTerminalRuntimeState {
  /** The most recently observed manager id, or `null` before any event. */
  readonly managerId: string | null;
  /** Current terminals keyed by terminal id; iteration order is creation order. */
  readonly terminals: ReadonlyMap<string, BackgroundTerminalEntry>;
  /** Highest applied sequence per manager, used for deduplication. */
  readonly managerSequences: ReadonlyMap<string, number>;
  /** Recent control acknowledgements (bounded), newest last. */
  readonly controlResults: ReadonlyArray<BackgroundTerminalControlEntry>;
  /** Monotonic version bumped on every applied (non-stale) event. */
  readonly version: number;
}

export interface ApplyBackgroundTerminalEventOptions {
  readonly maxOutputBytes?: number;
  readonly maxControlResults?: number;
}

export const EMPTY_BACKGROUND_TERMINAL_RUNTIME_STATE: BackgroundTerminalRuntimeState =
  Object.freeze({
    managerId: null,
    terminals: new Map<string, BackgroundTerminalEntry>(),
    managerSequences: new Map<string, number>(),
    controlResults: [] as ReadonlyArray<BackgroundTerminalControlEntry>,
    version: 0,
  });

export function isBackgroundTerminalActive(status: PiBackgroundTerminalStatus): boolean {
  return status === "running";
}

export function isBackgroundTerminalTerminal(status: PiBackgroundTerminalStatus): boolean {
  return !isBackgroundTerminalActive(status);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Trim `text` to at most `maxBytes` UTF-8 bytes, keeping the *tail* (the most
 * recent output). Trims forward from the cut point past any UTF-8
 * continuation bytes so the result is always valid, complete text — no
 * split multi-byte sequences and no lossy replacement characters.
 */
export function trimToUtf8ByteBudget(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly trimmedBytes: number } {
  if (maxBytes <= 0) {
    return { text: "", trimmedBytes: textEncoder.encode(text).length };
  }
  const bytes = textEncoder.encode(text);
  if (bytes.length <= maxBytes) {
    return { text, trimmedBytes: 0 };
  }
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return { text: textDecoder.decode(bytes.subarray(start)), trimmedBytes: start };
}

/** True when this buffer no longer represents the terminal's full output history. */
export function isBackgroundTerminalOutputTruncated(
  buffer: BackgroundTerminalOutputBuffer,
): boolean {
  return buffer.truncatedBytes + buffer.clientTruncatedBytes > 0;
}

function initOutputBuffer(
  output: PiBackgroundTerminalOutputView,
  maxBytes: number,
): BackgroundTerminalOutputBuffer {
  const { text, trimmedBytes } = trimToUtf8ByteBudget(output.text, maxBytes);
  return {
    text,
    totalBytes: output.totalBytes,
    truncatedBytes: output.truncatedBytes,
    clientTruncatedBytes: trimmedBytes,
  };
}

function suffixPrefixOverlap(current: string, tail: string) {
  if (current.length === 0 || tail.length === 0) return 0;
  const prefix = Array.from({ length: tail.length }, () => 0);
  for (let index = 1, matched = 0; index < tail.length; index += 1) {
    while (matched > 0 && tail[index] !== tail[matched]) {
      matched = prefix[matched - 1]!;
    }
    if (tail[index] === tail[matched]) matched += 1;
    prefix[index] = matched;
  }

  const suffix = current.slice(-tail.length);
  let matched = 0;
  for (let index = 0; index < suffix.length; index += 1) {
    const character = suffix[index];
    while (matched > 0 && character !== tail[matched]) {
      matched = prefix[matched - 1]!;
    }
    if (character === tail[matched]) matched += 1;
  }
  return matched;
}

function reconcileOutputBuffer(
  current: BackgroundTerminalOutputBuffer | undefined,
  output: PiBackgroundTerminalOutputView,
  maxBytes: number,
): BackgroundTerminalOutputBuffer {
  if (current === undefined || output.totalBytes < current.totalBytes) {
    return initOutputBuffer(output, maxBytes);
  }
  let merged: string;
  let retainedClientHistory = true;
  let recoveredPrefixBytes = 0;
  if (output.totalBytes === current.totalBytes) {
    if (current.text.endsWith(output.text)) {
      merged = current.text;
      recoveredPrefixBytes = textEncoder.encode(
        current.text.slice(0, current.text.length - output.text.length),
      ).length;
    } else {
      merged = output.text;
      retainedClientHistory = false;
    }
  } else {
    const overlap = suffixPrefixOverlap(current.text, output.text);
    const appendedText = output.text.slice(overlap);
    const reportedNewBytes = output.totalBytes - current.totalBytes;
    const overlapIsContiguous =
      overlap > 0 && textEncoder.encode(appendedText).length === reportedNewBytes;
    if (overlapIsContiguous) {
      merged = current.text + appendedText;
      recoveredPrefixBytes = textEncoder.encode(
        current.text.slice(0, current.text.length - overlap),
      ).length;
    } else {
      // A string overlap is not enough to prove continuity: after a reconnect
      // it may be incidental while bytes are missing in between. Trust only an
      // overlap whose appended UTF-8 size exactly accounts for totalBytes.
      merged = output.text;
      retainedClientHistory = false;
    }
  }
  const { text, trimmedBytes } = trimToUtf8ByteBudget(merged, maxBytes);
  return {
    text,
    totalBytes: output.totalBytes,
    // An upsert carries the bridge's bounded tail. If this browser still has
    // the immediately preceding prefix, that portion is not actually absent
    // from the merged client view and must not trigger a truncation warning.
    truncatedBytes: Math.max(0, output.truncatedBytes - recoveredPrefixBytes),
    clientTruncatedBytes: (retainedClientHistory ? current.clientTruncatedBytes : 0) + trimmedBytes,
  };
}

function appendOrReplaceOutput(
  buffer: BackgroundTerminalOutputBuffer,
  delta: PiBackgroundTerminalOutputDelta,
  maxBytes: number,
): BackgroundTerminalOutputBuffer {
  const merged = delta.replace ? delta.text : buffer.text + delta.text;
  const { text, trimmedBytes } = trimToUtf8ByteBudget(merged, maxBytes);
  return {
    text,
    totalBytes: delta.totalBytes,
    truncatedBytes: delta.truncatedBytes,
    clientTruncatedBytes: (delta.replace ? 0 : buffer.clientTruncatedBytes) + trimmedBytes,
  };
}

function advanceManagerSequence(
  managerSequences: ReadonlyMap<string, number>,
  managerId: string,
  sequence: number,
): ReadonlyMap<string, number> {
  const last = managerSequences.get(managerId);
  if (last !== undefined && last >= sequence) {
    return managerSequences;
  }
  const next = new Map(managerSequences);
  next.set(managerId, sequence);
  return next;
}

function isStaleSequence(
  state: BackgroundTerminalRuntimeState,
  managerId: string,
  sequence: number,
): boolean {
  const last = state.managerSequences.get(managerId);
  return last !== undefined && sequence <= last;
}

function upsertTerminal(
  terminals: ReadonlyMap<string, BackgroundTerminalEntry>,
  view: PiBackgroundTerminalView,
  sequence: number,
  timestamp: string,
  maxOutputBytes: number,
): ReadonlyMap<string, BackgroundTerminalEntry> {
  const existing = terminals.get(view.id);
  const next = new Map(terminals);
  next.set(view.id, {
    view,
    stdout: reconcileOutputBuffer(existing?.stdout, view.stdout, maxOutputBytes),
    stderr: reconcileOutputBuffer(existing?.stderr, view.stderr, maxOutputBytes),
    lastSequence: sequence,
    updatedAt: timestamp,
  });
  return next;
}

function removeTerminal(
  terminals: ReadonlyMap<string, BackgroundTerminalEntry>,
  terminalId: string,
): ReadonlyMap<string, BackgroundTerminalEntry> {
  if (!terminals.has(terminalId)) {
    return terminals;
  }
  const next = new Map(terminals);
  next.delete(terminalId);
  return next;
}

function applyOutputDelta(
  terminals: ReadonlyMap<string, BackgroundTerminalEntry>,
  terminalId: string,
  delta: PiBackgroundTerminalOutputDelta,
  sequence: number,
  timestamp: string,
  maxOutputBytes: number,
): ReadonlyMap<string, BackgroundTerminalEntry> {
  const existing = terminals.get(terminalId);
  // Output for a terminal whose view has not been seen yet is dropped rather
  // than synthesizing a placeholder entry we cannot populate with metadata.
  // `terminal_upsert` always precedes `terminal_output` for a given terminal
  // in a well-formed stream.
  if (existing === undefined) {
    return terminals;
  }
  const isStdout = delta.stream === "stdout";
  const updatedBuffer = appendOrReplaceOutput(
    isStdout ? existing.stdout : existing.stderr,
    delta,
    maxOutputBytes,
  );
  const next = new Map(terminals);
  next.set(terminalId, {
    ...existing,
    stdout: isStdout ? updatedBuffer : existing.stdout,
    stderr: isStdout ? existing.stderr : updatedBuffer,
    lastSequence: Math.max(existing.lastSequence, sequence),
    updatedAt: timestamp,
  });
  return next;
}

function appendControlResult(
  controlResults: ReadonlyArray<BackgroundTerminalControlEntry>,
  entry: BackgroundTerminalControlEntry,
  maxControlResults: number,
): ReadonlyArray<BackgroundTerminalControlEntry> {
  const appended = [...controlResults, entry];
  return maxControlResults > 0 && appended.length > maxControlResults
    ? appended.slice(appended.length - maxControlResults)
    : appended;
}

function applySnapshot(
  state: BackgroundTerminalRuntimeState,
  event: PiBackgroundTerminalEvent,
  terminalViews: ReadonlyArray<PiBackgroundTerminalView>,
  maxOutputBytes: number,
): BackgroundTerminalRuntimeState {
  // The snapshot is authoritative: rebuild the terminal set from scratch. A
  // terminal absent from the snapshot (e.g. a brand new manager after
  // reconnect) is dropped, which is how an empty snapshot clears stale state.
  const rebuilt = new Map<string, BackgroundTerminalEntry>();
  for (const view of terminalViews) {
    rebuilt.set(view.id, {
      view,
      stdout: initOutputBuffer(view.stdout, maxOutputBytes),
      stderr: initOutputBuffer(view.stderr, maxOutputBytes),
      lastSequence: event.sequence,
      updatedAt: event.timestamp,
    });
  }

  return {
    managerId: event.managerId,
    terminals: rebuilt,
    managerSequences: advanceManagerSequence(
      state.managerSequences,
      event.managerId,
      event.sequence,
    ),
    controlResults: state.controlResults,
    version: state.version + 1,
  };
}

/**
 * Fold a single background-terminal event into the runtime state. Pure:
 * returns the same reference when the event is a duplicate (stale sequence),
 * so callers can rely on referential equality to skip re-renders.
 */
export function applyBackgroundTerminalEvent(
  state: BackgroundTerminalRuntimeState,
  event: PiBackgroundTerminalEvent,
  options: ApplyBackgroundTerminalEventOptions = {},
): BackgroundTerminalRuntimeState {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_BACKGROUND_TERMINAL_OUTPUT_BYTES;
  const maxControlResults =
    options.maxControlResults ?? DEFAULT_MAX_BACKGROUND_TERMINAL_CONTROL_RESULTS;

  if (isStaleSequence(state, event.managerId, event.sequence)) {
    return state;
  }

  if (event.kind === "snapshot") {
    return applySnapshot(state, event, event.snapshot.terminals, maxOutputBytes);
  }

  let terminals = state.terminals;
  let controlResults = state.controlResults;

  switch (event.kind) {
    case "terminal_upsert": {
      terminals = upsertTerminal(
        terminals,
        event.view,
        event.sequence,
        event.timestamp,
        maxOutputBytes,
      );
      break;
    }
    case "terminal_output": {
      terminals = applyOutputDelta(
        terminals,
        event.terminalId,
        event.output,
        event.sequence,
        event.timestamp,
        maxOutputBytes,
      );
      break;
    }
    case "terminal_removed": {
      terminals = removeTerminal(terminals, event.terminalId);
      break;
    }
    case "control_result": {
      controlResults = appendControlResult(
        controlResults,
        { ...event.control, sequence: event.sequence, timestamp: event.timestamp },
        maxControlResults,
      );
      break;
    }
  }

  return {
    managerId: event.managerId,
    terminals,
    managerSequences: advanceManagerSequence(
      state.managerSequences,
      event.managerId,
      event.sequence,
    ),
    controlResults,
    version: state.version + 1,
  };
}

export function selectBackgroundTerminals(
  state: BackgroundTerminalRuntimeState,
): ReadonlyArray<BackgroundTerminalEntry> {
  return Array.from(state.terminals.values());
}

export function selectBackgroundTerminal(
  state: BackgroundTerminalRuntimeState,
  terminalId: string,
): BackgroundTerminalEntry | null {
  return state.terminals.get(terminalId) ?? null;
}

export function hasBackgroundTerminals(state: BackgroundTerminalRuntimeState): boolean {
  return state.terminals.size > 0;
}

export function selectActiveBackgroundTerminals(
  state: BackgroundTerminalRuntimeState,
): ReadonlyArray<BackgroundTerminalEntry> {
  return selectBackgroundTerminals(state).filter((entry) =>
    isBackgroundTerminalActive(entry.view.status),
  );
}

export function selectBackgroundTerminalControlResult(
  state: BackgroundTerminalRuntimeState,
  requestId: string,
): BackgroundTerminalControlEntry | null {
  for (let index = state.controlResults.length - 1; index >= 0; index -= 1) {
    const entry = state.controlResults[index];
    if (entry !== undefined && entry.requestId === requestId) {
      return entry;
    }
  }
  return null;
}
