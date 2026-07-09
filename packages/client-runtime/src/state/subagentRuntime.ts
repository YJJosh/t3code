import type {
  PiSubagentControlResult,
  PiSubagentEvent,
  PiSubagentEventKind,
  PiSubagentReplayEvent,
  PiSubagentRunStatus,
  PiSubagentRunView,
  PiSubagentSnapshot,
} from "@t3tools/contracts";

/**
 * Pure client-side state model for structured Pi subagent ("child agent")
 * events. The server exposes a per-thread event stream (`subscribeSubagentEvents`)
 * plus a `replay` control that pushes a `snapshot` event carrying the current
 * run views and the historical (persisted) events. This module folds that
 * stream into a compact, reconnect-safe projection that both desktop and mobile
 * surfaces can render.
 *
 * Design constraints handled here:
 * - Ordered manager sequences: every event carries `managerId` + monotonic
 *   `sequence`; duplicates (re-delivered after reconnect) are ignored.
 * - Snapshots with nested replay events: a `snapshot` event rebuilds the run
 *   set and replays its nested events to reconstruct per-run activity.
 * - Bounded per-run activity history so long-lived runs cannot grow without
 *   limit.
 */

export const DEFAULT_MAX_SUBAGENT_ACTIVITY = 200;
export const DEFAULT_MAX_SUBAGENT_CONTROL_RESULTS = 50;

export interface SubagentActivityEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: PiSubagentEventKind;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly liveOnly: boolean;
}

export interface SubagentRunEntry {
  readonly view: PiSubagentRunView;
  readonly activity: ReadonlyArray<SubagentActivityEntry>;
  readonly lastSequence: number;
  readonly updatedAt: string;
}

export interface SubagentControlEntry extends PiSubagentControlResult {
  readonly sequence: number;
  readonly timestamp: string;
}

export interface SubagentRuntimeState {
  /** The most recently observed manager id, or `null` before any event. */
  readonly managerId: string | null;
  /** Current run views keyed by `runId`; iteration order is spawn order. */
  readonly runs: ReadonlyMap<string, SubagentRunEntry>;
  /** Highest applied sequence per manager, used for deduplication. */
  readonly managerSequences: ReadonlyMap<string, number>;
  /** Recent control acknowledgements (bounded), newest last. */
  readonly controlResults: ReadonlyArray<SubagentControlEntry>;
  /** Monotonic version bumped on every applied change (never on a no-op). */
  readonly version: number;
}

export interface ApplySubagentEventOptions {
  readonly maxActivity?: number;
  readonly maxControlResults?: number;
}

export const EMPTY_SUBAGENT_RUNTIME_STATE: SubagentRuntimeState = Object.freeze({
  managerId: null,
  runs: new Map<string, SubagentRunEntry>(),
  managerSequences: new Map<string, number>(),
  controlResults: [] as ReadonlyArray<SubagentControlEntry>,
  version: 0,
});

const TERMINAL_STATUSES: ReadonlySet<PiSubagentRunStatus> = new Set([
  "done",
  "failed",
  "killed",
  "interrupted",
]);

const ACTIVE_STATUSES: ReadonlySet<PiSubagentRunStatus> = new Set(["spawning", "running"]);

export function isSubagentRunTerminal(status: PiSubagentRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isSubagentRunActive(status: PiSubagentRunStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function subagentRunNeedsInput(status: PiSubagentRunStatus): boolean {
  return status === "needs_input";
}

/**
 * A shared shape for both top-level events and the nested replay events carried
 * inside a snapshot. They differ structurally (replay events cannot carry a
 * nested snapshot) but share every field the reducer reads.
 */
interface SubagentEventLike {
  readonly managerId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: PiSubagentEventKind;
  readonly runId?: string | undefined;
  readonly view?: PiSubagentRunView | undefined;
  readonly activity?: PiSubagentEvent["activity"];
  readonly control?: PiSubagentControlResult | undefined;
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
  state: SubagentRuntimeState,
  managerId: string,
  sequence: number,
): boolean {
  const last = state.managerSequences.get(managerId);
  return last !== undefined && sequence <= last;
}

function upsertRunView(
  runs: ReadonlyMap<string, SubagentRunEntry>,
  runId: string,
  view: PiSubagentRunView,
  sequence: number,
  timestamp: string,
): ReadonlyMap<string, SubagentRunEntry> {
  const existing = runs.get(runId);
  const next = new Map(runs);
  next.set(runId, {
    view,
    activity: existing?.activity ?? [],
    lastSequence: Math.max(existing?.lastSequence ?? 0, sequence),
    updatedAt: timestamp,
  });
  return next;
}

function appendRunActivity(
  runs: ReadonlyMap<string, SubagentRunEntry>,
  runId: string,
  entry: SubagentActivityEntry,
  maxActivity: number,
): ReadonlyMap<string, SubagentRunEntry> {
  const existing = runs.get(runId);
  // Activity for a run whose view has not been seen yet is dropped rather than
  // synthesizing a placeholder view we cannot populate. run_created always
  // precedes child activity in a well-formed stream.
  if (existing === undefined) {
    return runs;
  }
  const appended = [...existing.activity, entry];
  const bounded =
    maxActivity > 0 && appended.length > maxActivity
      ? appended.slice(appended.length - maxActivity)
      : appended;
  const next = new Map(runs);
  next.set(runId, {
    ...existing,
    activity: bounded,
    lastSequence: Math.max(existing.lastSequence, entry.sequence),
    updatedAt: entry.timestamp,
  });
  return next;
}

function appendControlResult(
  controlResults: ReadonlyArray<SubagentControlEntry>,
  entry: SubagentControlEntry,
  maxControlResults: number,
): ReadonlyArray<SubagentControlEntry> {
  const appended = [...controlResults, entry];
  return maxControlResults > 0 && appended.length > maxControlResults
    ? appended.slice(appended.length - maxControlResults)
    : appended;
}

interface RunsAndControls {
  readonly runs: ReadonlyMap<string, SubagentRunEntry>;
  readonly controlResults: ReadonlyArray<SubagentControlEntry>;
}

function reduceRunsForEvent(
  base: RunsAndControls,
  event: SubagentEventLike,
  maxActivity: number,
  maxControlResults: number,
): RunsAndControls {
  let runs = base.runs;
  const runId = event.view?.runId ?? event.runId;

  if (event.view !== undefined && runId !== undefined) {
    runs = upsertRunView(runs, runId, event.view, event.sequence, event.timestamp);
  }

  if (event.activity !== undefined && runId !== undefined) {
    runs = appendRunActivity(
      runs,
      runId,
      {
        sequence: event.sequence,
        timestamp: event.timestamp,
        kind: event.kind,
        type: event.activity.type,
        data: event.activity.data,
        liveOnly: event.activity.liveOnly ?? false,
      },
      maxActivity,
    );
  }

  let controlResults = base.controlResults;
  if (event.control !== undefined) {
    controlResults = appendControlResult(
      controlResults,
      { ...event.control, sequence: event.sequence, timestamp: event.timestamp },
      maxControlResults,
    );
  }

  return { runs, controlResults };
}

function applySnapshot(
  state: SubagentRuntimeState,
  event: PiSubagentEvent,
  snapshot: PiSubagentSnapshot,
  maxActivity: number,
  maxControlResults: number,
): SubagentRuntimeState {
  // The snapshot is authoritative: rebuild the run set from its run views and
  // reconstruct activity by replaying its nested events in sequence order.
  const rebuiltRuns = new Map<string, SubagentRunEntry>();
  for (const view of snapshot.runs) {
    rebuiltRuns.set(view.runId, {
      view,
      activity: [],
      lastSequence: event.sequence,
      updatedAt: event.timestamp,
    });
  }

  let working: RunsAndControls = {
    runs: rebuiltRuns,
    controlResults: state.controlResults,
  };
  let managerSequences = state.managerSequences;

  const nested: ReadonlyArray<PiSubagentReplayEvent> = snapshot.events ?? [];
  const ordered = [...nested].sort((left, right) => left.sequence - right.sequence);
  for (const replay of ordered) {
    // Snapshot run views are authoritative. Nested replay views are historical
    // lifecycle records and are used only to reconstruct activity/control
    // history; allowing them to upsert views could roll a current `running`
    // snapshot back to an earlier `spawning` state or resurrect a stale run.
    working = reduceRunsForEvent(
      working,
      { ...replay, view: undefined },
      maxActivity,
      maxControlResults,
    );
    managerSequences = advanceManagerSequence(managerSequences, replay.managerId, replay.sequence);
  }

  // Reassert snapshot timestamps after older replay activity was folded in.
  const currentRuns = new Map(working.runs);
  for (const view of snapshot.runs) {
    const rebuilt = currentRuns.get(view.runId);
    if (rebuilt !== undefined) {
      currentRuns.set(view.runId, {
        ...rebuilt,
        view,
        lastSequence: Math.max(rebuilt.lastSequence, event.sequence),
        updatedAt: event.timestamp,
      });
    }
  }

  managerSequences = advanceManagerSequence(managerSequences, event.managerId, event.sequence);

  return {
    managerId: event.managerId,
    runs: currentRuns,
    managerSequences,
    controlResults: working.controlResults,
    version: state.version + 1,
  };
}

/**
 * Fold a single subagent event into the runtime state. Pure: returns the same
 * reference when the event is a duplicate (stale sequence) or has no effect, so
 * callers can rely on referential equality to skip re-renders.
 */
export function applySubagentEvent(
  state: SubagentRuntimeState,
  event: PiSubagentEvent,
  options: ApplySubagentEventOptions = {},
): SubagentRuntimeState {
  const maxActivity = options.maxActivity ?? DEFAULT_MAX_SUBAGENT_ACTIVITY;
  const maxControlResults = options.maxControlResults ?? DEFAULT_MAX_SUBAGENT_CONTROL_RESULTS;

  if (isStaleSequence(state, event.managerId, event.sequence)) {
    return state;
  }

  if (event.kind === "snapshot" && event.snapshot !== undefined) {
    return applySnapshot(state, event, event.snapshot, maxActivity, maxControlResults);
  }

  const reduced = reduceRunsForEvent(
    { runs: state.runs, controlResults: state.controlResults },
    event,
    maxActivity,
    maxControlResults,
  );
  const managerSequences = advanceManagerSequence(
    state.managerSequences,
    event.managerId,
    event.sequence,
  );

  return {
    managerId: event.managerId,
    runs: reduced.runs,
    managerSequences,
    controlResults: reduced.controlResults,
    version: state.version + 1,
  };
}

export function selectSubagentRuns(state: SubagentRuntimeState): ReadonlyArray<SubagentRunEntry> {
  return Array.from(state.runs.values());
}

export function selectSubagentRun(
  state: SubagentRuntimeState,
  runId: string,
): SubagentRunEntry | null {
  return state.runs.get(runId) ?? null;
}

export function hasSubagentRuns(state: SubagentRuntimeState): boolean {
  return state.runs.size > 0;
}

export function selectActiveSubagentRuns(
  state: SubagentRuntimeState,
): ReadonlyArray<SubagentRunEntry> {
  return selectSubagentRuns(state).filter((entry) => !isSubagentRunTerminal(entry.view.state));
}

export function selectSubagentControlResult(
  state: SubagentRuntimeState,
  requestId: string,
): SubagentControlEntry | null {
  for (let index = state.controlResults.length - 1; index >= 0; index -= 1) {
    const entry = state.controlResults[index];
    if (entry !== undefined && entry.requestId === requestId) {
      return entry;
    }
  }
  return null;
}
