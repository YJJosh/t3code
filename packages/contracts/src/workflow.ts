import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Contracts for Claude Agent SDK workflow-run visibility.
 *
 * A "workflow" is a background orchestration task the Claude Agent SDK runs
 * in-process (the `Workflow` tool). The SDK streams a cumulative progress
 * snapshot on every `task_progress` message via the (currently undocumented)
 * `workflow_progress` field, and writes per-agent transcripts plus a result
 * journal to a transcript directory on disk. These schemas model the subset
 * the server forwards to clients.
 *
 * Every field that originates from the undocumented SDK surface is optional:
 * the adapter normalizes entries defensively, and clients must tolerate
 * absent fields so an SDK upgrade degrades to less detail, never to a
 * decode failure.
 */

/**
 * One `agent()` call inside a workflow run. `index` is the SDK's stable
 * per-run agent ordinal; snapshots are merged last-write-wins by `index`.
 * `state` is an open string ("start" | "done" | "error" today) — clients
 * must render unknown states as "running".
 */
export const WorkflowAgentProgressEntry = Schema.Struct({
  type: Schema.Literal("workflow_agent"),
  index: Schema.Number,
  state: Schema.String,
  label: Schema.optional(Schema.String),
  phaseIndex: Schema.optional(Schema.Number),
  phaseTitle: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  agentType: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  fallbackModel: Schema.optional(Schema.String),
  isolation: Schema.optional(Schema.Literals(["worktree", "remote"])),
  attempt: Schema.optional(Schema.Number),
  queuedAt: Schema.optional(Schema.Number),
  startedAt: Schema.optional(Schema.Number),
  lastProgressAt: Schema.optional(Schema.Number),
  cached: Schema.optional(Schema.Boolean),
  remoteSessionId: Schema.optional(Schema.String),
  lastToolName: Schema.optional(Schema.String),
  lastToolSummary: Schema.optional(Schema.String),
  promptPreview: Schema.optional(Schema.String),
  resultPreview: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  /** Cumulative output tokens, tool calls, and wall-clock duration for this
   * agent, as reported by the SDK snapshot. */
  tokens: Schema.optional(Schema.Number),
  toolCalls: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
});
export type WorkflowAgentProgressEntry = typeof WorkflowAgentProgressEntry.Type;

export const WorkflowPhaseProgressEntry = Schema.Struct({
  type: Schema.Literal("workflow_phase"),
  index: Schema.Number,
  title: Schema.String,
  kind: Schema.optional(Schema.String),
});
export type WorkflowPhaseProgressEntry = typeof WorkflowPhaseProgressEntry.Type;

/** A `log()` narration line emitted by the workflow script. */
export const WorkflowLogProgressEntry = Schema.Struct({
  type: Schema.Literal("workflow_log"),
  message: Schema.String,
});
export type WorkflowLogProgressEntry = typeof WorkflowLogProgressEntry.Type;

export const WorkflowProgressEntry = Schema.Union([
  WorkflowAgentProgressEntry,
  WorkflowPhaseProgressEntry,
  WorkflowLogProgressEntry,
]);
export type WorkflowProgressEntry = typeof WorkflowProgressEntry.Type;

/**
 * Handles returned by the Workflow tool result. `transcriptDir` and
 * `scriptPath` are server-local paths — clients echo them back to the
 * workflow inspection RPCs, which re-validate them structurally before
 * touching disk. `sessionUrl` replaces the local handles for remote runs.
 */
export const WorkflowRunHandles = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: Schema.optional(TrimmedNonEmptyString),
  workflowName: Schema.optional(TrimmedNonEmptyString),
  taskType: Schema.optional(TrimmedNonEmptyString),
  scriptPath: Schema.optional(TrimmedNonEmptyString),
  transcriptDir: Schema.optional(TrimmedNonEmptyString),
  sessionUrl: Schema.optional(TrimmedNonEmptyString),
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type WorkflowRunHandles = typeof WorkflowRunHandles.Type;

export class WorkflowInspectionError extends Schema.TaggedErrorClass<WorkflowInspectionError>()(
  "WorkflowInspectionError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["invalid-path", "not-found", "read-failed", "unsupported"]),
    detail: Schema.String,
    /** Underlying failure for read-failed/not-found wraps; absent for pure
     * validation reasons. Matches the GitCommandError convention. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workflow inspection failed in ${this.operation}: ${this.detail}`;
  }
}

export const WorkflowReadScriptInput = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
});
export type WorkflowReadScriptInput = typeof WorkflowReadScriptInput.Type;

export const WorkflowReadScriptResult = Schema.Struct({
  source: Schema.String,
  truncated: Schema.Boolean,
});
export type WorkflowReadScriptResult = typeof WorkflowReadScriptResult.Type;

export const WorkflowReadJournalInput = Schema.Struct({
  transcriptDir: TrimmedNonEmptyString,
});
export type WorkflowReadJournalInput = typeof WorkflowReadJournalInput.Type;

/**
 * One journal record per agent. `resultJson` is the agent's return value
 * re-serialized as JSON, truncated server-side; `resultTruncated` marks the
 * clip. Agents with a `started` record but no `result` yet report
 * `hasResult: false`.
 */
export const WorkflowJournalEntry = Schema.Struct({
  agentId: Schema.String,
  hasResult: Schema.Boolean,
  resultJson: Schema.optional(Schema.String),
  resultTruncated: Schema.optional(Schema.Boolean),
});
export type WorkflowJournalEntry = typeof WorkflowJournalEntry.Type;

export const WorkflowReadJournalResult = Schema.Struct({
  entries: Schema.Array(WorkflowJournalEntry),
  truncated: Schema.Boolean,
});
export type WorkflowReadJournalResult = typeof WorkflowReadJournalResult.Type;

export const WorkflowReadAgentTranscriptInput = Schema.Struct({
  transcriptDir: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  /** Zero-based line cursor; omit to read from the start. */
  afterLine: Schema.optional(Schema.Int),
});
export type WorkflowReadAgentTranscriptInput = typeof WorkflowReadAgentTranscriptInput.Type;

/**
 * Raw transcript JSONL lines starting after the cursor. `nextLine` is the
 * cursor for the next page; `complete` means the read reached end-of-file
 * (more lines may still be appended while the agent runs — poll again).
 */
export const WorkflowReadAgentTranscriptResult = Schema.Struct({
  lines: Schema.Array(Schema.String),
  nextLine: Schema.Int,
  complete: Schema.Boolean,
});
export type WorkflowReadAgentTranscriptResult = typeof WorkflowReadAgentTranscriptResult.Type;
